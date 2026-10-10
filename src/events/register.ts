import {
  ProtocolError,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  listParams,
  subscribeParams,
  subscriptionState,
  unsubscribeParams,
  webhookFailures,
} from "./schemas";
import { canonical } from "./json";
import {
  detectDialect,
  errorCode,
  errorName,
  eventsCapabilities,
  type EventsErrorName,
  type ExperimentalMcpEventsDialect,
} from "./protocol";
import { validateUrl, validateSecret } from "./webhook-validation";
import type {
  ExperimentalMcpEventContext,
  ExperimentalMcpEventDefinition,
  ExperimentalMcpEventsOptions,
  ExperimentalMcpSubscriptionKey,
} from "./types";

const registered = new WeakSet<McpServer>();

/**
 * Register the draft MCP Events webhook control methods on the existing MCP
 * endpoint. Storage and delivery must live outside the per-request server.
 *
 * @experimental Follows draft SEP-3415, with ChatGPT's design-sketch dialect
 * detected per request unless `chatgptCompat` is false. Not a stable MCP
 * specification. Poll/stream delivery and model-tool generation are excluded.
 */
export function experimental_registerMcpEvents(
  server: McpServer,
  options: ExperimentalMcpEventsOptions,
): void {
  if (registered.has(server)) throw new Error("MCP Events already registered");
  const { minMs, defaultMs, maxMs } = resolveTtl(options.ttl);
  registered.add(server);
  const chatgptCompat = options.chatgptCompat ?? true;

  server.server.registerCapabilities(eventsCapabilities(chatgptCompat));

  async function context(
    ctx: ServerContext,
  ): Promise<ExperimentalMcpEventContext> {
    const authInfo = ctx.http?.authInfo;
    if (
      !authInfo ||
      (authInfo.expiresAt !== undefined &&
        authInfo.expiresAt <= Date.now() / 1000)
    ) {
      throw new EventsError("Forbidden", "Authentication required");
    }
    const principal = await options.getPrincipal(authInfo);
    if (typeof principal !== "string" || !principal.trim()) {
      throw new EventsError("Forbidden", "Authenticated principal required");
    }
    return { principal, authInfo, signal: ctx.mcpReq.signal };
  }

  async function catalog(ctx: ExperimentalMcpEventContext) {
    const events =
      typeof options.events === "function"
        ? await options.events(ctx)
        : options.events;
    const names = new Set<string>();
    for (const event of events) {
      if (!event.name || names.has(event.name))
        throw new Error("Invalid event catalog");
      names.add(event.name);
    }
    const visible: ExperimentalMcpEventDefinition[] = [];
    for (const event of events) {
      ctx.signal.throwIfAborted();
      // Filter-specific authorize() cannot run until arguments are supplied.
      if (
        event.authorizeDiscovery === undefined ||
        (await event.authorizeDiscovery(ctx)) === true
      ) {
        visible.push(event);
      }
    }
    ctx.signal.throwIfAborted();
    return visible;
  }

  server.server.setRequestHandler(
    "events/list",
    { params: listParams },
    async (params, ctx) =>
      safe(detectDialect(ctx, chatgptCompat), async () => {
        const auth = await context(ctx);
        // This adapter returns the complete account-scoped catalog in one page.
        if (params.cursor !== undefined)
          throw new ProtocolError(-32602, "Invalid catalog cursor");
        const events = await catalog(auth);
        return {
          events: events.map((event) => ({
            name: event.name,
            ...(event.description !== undefined
              ? { description: event.description }
              : {}),
            delivery: ["webhook"],
            inputSchema: event.inputSchema["~standard"].jsonSchema.input({
              target: "draft-2020-12",
            }),
            payloadSchema: event.payloadSchema["~standard"].jsonSchema.output({
              target: "draft-2020-12",
            }),
          })),
        };
      }),
  );

  server.server.setRequestHandler(
    "events/subscribe",
    { params: subscribeParams },
    async (params, ctx) => {
      const dialect = detectDialect(ctx, chatgptCompat);
      return safe(dialect, async () => {
        const auth = await context(ctx);
        if (params.delivery.mode !== "webhook") {
          throw new EventsError("Unsupported", "Unsupported delivery mode", {
            feature: "deliveryMode",
          });
        }
        validateUrl(params.delivery.url);
        validateSecret(params.delivery.secret);
        const event = (await catalog(auth)).find(
          (candidate) => candidate.name === params.name,
        );
        if (!event)
          throw new EventsError("NotFound", "Event not found", {
            kind: "event",
          });
        const checked = await event.inputSchema["~standard"].validate(
          params.arguments,
        );
        if (
          checked.issues ||
          canonical(checked.value) !== canonical(params.arguments)
        ) {
          throw new ProtocolError(
            -32602,
            "Arguments must match the event schema without transformation",
          );
        }
        if (
          (await event.authorize(params.arguments, {
            principal: auth.principal,
            signal: auth.signal,
          })) !== true
        ) {
          throw new EventsError("Forbidden", "Event arguments not authorized");
        }
        const key = await subscriptionKey(
          auth.principal,
          params.name,
          params.arguments,
          params.delivery.url,
        );
        auth.signal.throwIfAborted();
        const operationId = await options.subscriptions.prepare(key, auth);
        if (typeof operationId !== "string" || !operationId.trim()) {
          throw new Error("Invalid subscription operation");
        }
        auth.signal.throwIfAborted();
        const verification = await options.delivery.verifyEndpoint(
          { ...key, secret: params.delivery.secret },
          auth,
        );
        if (verification.verified !== true) {
          const reason = webhookFailures.includes(verification.reason)
            ? verification.reason
            : "challenge_failed";
          throw new EventsError(
            "CallbackEndpointError",
            "Callback verification failed",
            { reason },
          );
        }
        auth.signal.throwIfAborted();
        const ttl =
          params.ttlMs === null && options.ttl?.allowNoExpiry
            ? null
            : Math.max(minMs, Math.min(params.ttlMs ?? defaultMs, maxMs));
        const refreshBefore =
          ttl === null ? null : new Date(Date.now() + ttl).toISOString();
        const state = await options.subscriptions.upsert(
          {
            ...key,
            secret: params.delivery.secret,
            refreshBefore,
            cursor: params.cursor ?? null,
            ...(params.maxAgeMs !== undefined
              ? { maxAgeMs: params.maxAgeMs }
              : {}),
            protocol: dialect,
          },
          auth,
          operationId,
        );
        const result = await subscriptionState["~standard"].validate(state);
        if (result.issues) throw new Error("Invalid subscription state");
        return { id: key.id, refreshBefore, ...result.value };
      });
    },
  );

  server.server.setRequestHandler(
    "events/unsubscribe",
    { params: unsubscribeParams },
    async (params, ctx) =>
      safe(detectDialect(ctx, chatgptCompat), async () => {
        const auth = await context(ctx);
        validateUrl(params.delivery.url);
        const key = await subscriptionKey(
          auth.principal,
          params.name,
          params.arguments,
          params.delivery.url,
        );
        // Cleanup must remain possible after an event is removed or its schema changes.
        auth.signal.throwIfAborted();
        if (!(await options.subscriptions.remove(key, auth))) {
          throw new EventsError("NotFound", "Subscription not found", {
            kind: "subscription",
          });
        }
        return {};
      }),
  );
}

/** Apply TTL defaults and reject invalid bounds. */
export function resolveTtl(ttl: ExperimentalMcpEventsOptions["ttl"]) {
  const minMs = ttl?.minMs ?? 60_000;
  const defaultMs = ttl?.defaultMs ?? 3_600_000;
  const maxMs = ttl?.maxMs ?? 86_400_000;
  if (
    ![minMs, defaultMs, maxMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    minMs > defaultMs ||
    defaultMs > maxMs ||
    maxMs > 8.64e15 - Date.now()
  )
    throw new Error(
      "MCP Events TTLs must satisfy 0 < minMs <= defaultMs <= maxMs",
    );
  return { minMs, defaultMs, maxMs };
}

async function subscriptionKey(
  principal: string,
  name: string,
  args: Record<string, unknown>,
  url: string,
): Promise<ExperimentalMcpSubscriptionKey> {
  const bytes = new TextEncoder().encode(
    canonical([principal, url, name, args]),
  );
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const id =
    "sub_" +
    Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  return { id, principal, name, arguments: args, url };
}

/** A protocol error named by meaning; safe() picks the dialect's code. */
class EventsError extends Error {
  constructor(
    readonly kind: EventsErrorName,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const messages: Record<EventsErrorName, string> = {
  NotFound: "Event or subscription not found",
  Forbidden: "Forbidden",
  ResourceExhausted: "Resource exhausted",
  Unsupported: "Unsupported event option",
  CallbackEndpointError: "Callback verification failed",
};

async function safe<T>(
  dialect: ExperimentalMcpEventsDialect,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Adapter exceptions can contain webhook secrets or endpoint response data.
    // Adapters may throw ProtocolErrors in either dialect's numbering.
    const kind =
      error instanceof EventsError
        ? error.kind
        : error instanceof ProtocolError
        ? errorName(error.code)
        : undefined;
    if (kind) {
      // Only fixed categories cross the wire, including for intentional adapter errors.
      const data = (error as EventsError | ProtocolError).data as
        | { reason?: unknown; kind?: unknown; feature?: unknown }
        | undefined;
      const detail =
        kind === "CallbackEndpointError" &&
        webhookFailures.some((reason) => reason === data?.reason)
          ? { reason: data!.reason }
          : kind === "NotFound" &&
            (data?.kind === "event" || data?.kind === "subscription")
          ? { kind: data.kind }
          : kind === "Unsupported" && data?.feature === "deliveryMode"
          ? { feature: "deliveryMode" }
          : undefined;
      throw new ProtocolError(errorCode(dialect, kind), messages[kind], detail);
    }
    if (error instanceof ProtocolError && error.code === -32602)
      throw new ProtocolError(-32602, "Invalid event parameters");
    throw new ProtocolError(-32603, "MCP Events operation failed");
  }
}
