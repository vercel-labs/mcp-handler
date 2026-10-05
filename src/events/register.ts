import {
  ProtocolError,
  type McpServer,
  type ServerCapabilities,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  listParams,
  subscribeParams,
  subscriptionState,
  unsubscribeParams,
  webhookFailures,
} from "./schemas";
import type {
  ExperimentalMcpEventContext,
  ExperimentalMcpEventsOptions,
  ExperimentalMcpSubscriptionKey,
} from "./types";

const registered = new WeakSet<McpServer>();

/**
 * Register the draft MCP Events webhook control methods on the existing MCP
 * endpoint. Storage and delivery must live outside the per-request server.
 *
 * @experimental Follows the experimental MCP Events design sketch, not a stable
 * MCP specification. Poll/stream delivery and model-tool generation are excluded.
 */
export function experimental_registerMcpEvents(
  server: McpServer,
  options: ExperimentalMcpEventsOptions,
): void {
  if (registered.has(server)) throw new Error("MCP Events already registered");
  const minMs = options.ttl?.minMs ?? 60_000;
  const defaultMs = options.ttl?.defaultMs ?? 3_600_000;
  const maxMs = options.ttl?.maxMs ?? 86_400_000;
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
  registered.add(server);

  // The SDK preserves extension capabilities but does not yet type events.
  server.server.registerCapabilities({ events: {} } as ServerCapabilities);

  async function context(
    ctx: ServerContext,
  ): Promise<ExperimentalMcpEventContext> {
    const authInfo = ctx.http?.authInfo;
    if (
      !authInfo ||
      (authInfo.expiresAt !== undefined &&
        authInfo.expiresAt <= Date.now() / 1000)
    ) {
      throw new ProtocolError(-32012, "Authentication required");
    }
    const principal = await options.getPrincipal(authInfo);
    if (typeof principal !== "string" || !principal.trim()) {
      throw new ProtocolError(-32012, "Authenticated principal required");
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
    return events;
  }

  server.server.setRequestHandler(
    "events/list",
    { params: listParams },
    async (params, ctx) =>
      safe(async () => {
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
    async (params, ctx) =>
      safe(async () => {
        const auth = await context(ctx);
        if (params.delivery.mode !== "webhook") {
          throw new ProtocolError(-32014, "Unsupported delivery mode", {
            feature: "deliveryMode",
          });
        }
        validateUrl(params.delivery.url);
        validateSecret(params.delivery.secret);
        const event = (await catalog(auth)).find(
          (candidate) => candidate.name === params.name,
        );
        if (!event)
          throw new ProtocolError(-32011, "Event not found", { kind: "event" });
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
        if ((await event.authorize(params.arguments, auth)) !== true) {
          throw new ProtocolError(-32012, "Event arguments are not authorized");
        }
        const key = await subscriptionKey(
          auth.principal,
          params.name,
          params.arguments,
          params.delivery.url,
        );
        auth.signal.throwIfAborted();
        const verification = await options.delivery.verifyEndpoint(
          { ...key, secret: params.delivery.secret },
          auth,
        );
        if (verification.verified !== true) {
          const reason = webhookFailures.includes(verification.reason)
            ? verification.reason
            : "challenge_failed";
          throw new ProtocolError(-32015, "Callback verification failed", {
            reason,
          });
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
          },
          auth,
        );
        const result = await subscriptionState["~standard"].validate(state);
        if (result.issues) throw new Error("Invalid subscription state");
        return { id: key.id, refreshBefore, ...result.value };
      }),
  );

  server.server.setRequestHandler(
    "events/unsubscribe",
    { params: unsubscribeParams },
    async (params, ctx) =>
      safe(async () => {
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
          throw new ProtocolError(-32011, "Subscription not found", {
            kind: "subscription",
          });
        }
        return {};
      }),
  );
}

function validateUrl(value: string): void {
  try {
    const url = new URL(value);
    if (
      !value.startsWith("https://") ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new ProtocolError(
      -32602,
      "Callback must be an HTTPS URL without credentials or a fragment",
    );
  }
}

function validateSecret(value: string): void {
  try {
    if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error();
    const encoded = value.slice(6);
    const decoded = atob(encoded);
    if (
      decoded.length < 24 ||
      decoded.length > 64 ||
      btoa(decoded).replace(/=+$/, "") !== encoded.replace(/=+$/, "")
    )
      throw new Error();
  } catch {
    throw new ProtocolError(-32602, "Invalid Standard Webhooks secret");
  }
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

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical(
            (value as Record<string, unknown>)[key],
          )}`,
      )
      .join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Invalid JSON value");
  return result;
}

async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Adapter exceptions can contain webhook secrets or endpoint response data.
    if (
      error instanceof ProtocolError &&
      [-32602, -32011, -32012, -32013, -32014, -32015].includes(error.code)
    ) {
      const messages: Record<number, string> = {
        [-32602]: "Invalid event parameters",
        [-32011]: "Event or subscription not found",
        [-32012]: "Forbidden",
        [-32013]: "Resource exhausted",
        [-32014]: "Unsupported event option",
        [-32015]: "Callback verification failed",
      };
      // Only fixed categories cross the wire, including for intentional adapter errors.
      const data = error.data as
        | { reason?: unknown; kind?: unknown; feature?: unknown }
        | undefined;
      const detail =
        error.code === -32015 &&
        webhookFailures.some((reason) => reason === data?.reason)
          ? { reason: data!.reason }
          : error.code === -32011 &&
            (data?.kind === "event" || data?.kind === "subscription")
          ? { kind: data.kind }
          : error.code === -32014 && data?.feature === "deliveryMode"
          ? { feature: "deliveryMode" }
          : undefined;
      throw new ProtocolError(error.code, messages[error.code], detail);
    }
    throw new ProtocolError(-32603, "MCP Events operation failed");
  }
}
