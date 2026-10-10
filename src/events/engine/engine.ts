import { validateHeaderValue } from "node:http";
import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { canonical, snapshotJson } from "../json";
import { errorCode, type EventsErrorName } from "../protocol";
import { experimental_registerMcpEvents, resolveTtl } from "../register";
import type { ExperimentalMcpWebhookFailure } from "../types";
import {
  deliverWebhookEvent,
  sendWebhookControl,
  type WebhookNetworkOptions,
  type WebhookResult,
} from "../webhook";
import type { McpEvent } from "./define";
import type {
  McpEventsJob,
  McpEventsJobProcessor,
  McpEventsJobResult,
  McpEventsQueue,
} from "./queue";
import type { McpEventsStore } from "./store";
import {
  DEFAULT_PARTITION,
  cachedVerification,
  hash,
  isLive,
  keys,
  readRecord,
  recordStatus,
  removeRecord,
  storeSubscriptions,
  type Grant,
  type SubscriptionRecord,
} from "./subscriptions";

/** @experimental Options for `createMcpEvents`. */
export interface McpEventsOptions {
  events: readonly McpEvent[];
  /**
   * A stable, tenant/issuer-scoped identity from verified auth. Never use the
   * OAuth client ID as an end-user identity.
   */
  principal(authInfo: AuthInfo): string | Promise<string>;
  store: McpEventsStore;
  queue: McpEventsQueue;
  /** Granted subscription lifetimes. @default 1 min..1 h..1 day, no expiry off */
  ttl?: {
    minMs?: number;
    defaultMs?: number;
    maxMs?: number;
    allowNoExpiry?: boolean;
  };
  /** Also serve ChatGPT's design-sketch dialect. @default true */
  chatgptCompat?: boolean;
  /** Egress settings for verification and delivery requests. */
  network?: WebhookNetworkOptions;
  /** Attempts per event and subscription, including the first. @default 5 */
  maxDeliveryAttempts?: number;
  /** Active and pending subscriptions per principal. @default 100 */
  subscriptionsPerPrincipal?: number;
  /** Verification requests per principal and callback host. @default 10 */
  verificationsPerMinute?: number;
  /** Verification requests per callback host, across principals. @default 600 */
  hostVerificationsPerMinute?: number;
  /** How long a verified (principal, url) skips the challenge. @default 1 day */
  consentTtlMs?: number;
  /** How long deliveries stay signed with a replaced secret. @default 10 min */
  secretRotationGraceMs?: number;
  /** Called with unexpected errors while processing a job. */
  onError?(error: unknown, job: McpEventsJob): void;
}

/** @experimental Options for `emit`. */
export interface McpEventEmitOptions {
  /**
   * Stable across duplicate emits of the same occurrence, preferably the
   * upstream event ID. Becomes `eventId` and `webhook-id`.
   */
  id: string;
  /** When the event happened. @default now */
  occurredAt?: Date;
}

/** @experimental The events engine returned by `createMcpEvents`. */
export interface McpEvents {
  /** Register the events methods; `createMcpHandler`'s `events` option calls this. */
  register(server: McpServer): void;
  /** Queue an event for every matching subscription. */
  emit<Data>(
    event: McpEvent<any, Data>,
    data: Data,
    options: McpEventEmitOptions,
  ): Promise<void>;
  /** Run one queued job; queue consumers call this. */
  process: McpEventsJobProcessor;
}

const FANOUT_PAGE = 200;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const RETRY_DELAYS_MS = [30_000, 60_000, 180_000, 480_000];

const terminationMessages: Record<EventsErrorName, string> = {
  NotFound: "Event not found",
  Forbidden: "Forbidden",
  ResourceExhausted: "Resource exhausted",
  Unsupported: "Unsupported",
  CallbackEndpointError: "Callback endpoint error",
};

/**
 * Create the MCP Events engine: subscription storage, callback verification,
 * fan-out, signed delivery with retries, and revocation, on a store and a
 * queue you provide.
 *
 * @experimental Webhook delivery per draft SEP-3415, with ChatGPT compat.
 */
export function createMcpEvents(options: McpEventsOptions): McpEvents {
  const events = new Map<string, McpEvent>();
  for (const event of options.events) {
    if (!event.name || events.has(event.name))
      throw new Error("Event names must be unique and non-empty");
    events.set(event.name, event);
  }
  resolveTtl(options.ttl);
  const settings = {
    maxDeliveryAttempts: positive(options.maxDeliveryAttempts, 5),
    subscriptionsPerPrincipal: positive(options.subscriptionsPerPrincipal, 100),
    verificationsPerMinute: positive(options.verificationsPerMinute, 10),
    hostVerificationsPerMinute: positive(
      options.hostVerificationsPerMinute,
      600,
    ),
    consentTtlMs: positive(options.consentTtlMs, 86_400_000),
    secretRotationGraceMs: positive(options.secretRotationGraceMs, 600_000),
  };
  const { store, queue, network } = options;
  const catalog = [...events.values()];
  const subscriptions = storeSubscriptions({ store, events, ...settings });
  const delivery = cachedVerification({ store, network, ...settings });

  async function emit<Data>(
    event: McpEvent<any, Data>,
    data: Data,
    { id, occurredAt = new Date() }: McpEventEmitOptions,
  ) {
    const definition = events.get(event.name);
    if (definition !== event) throw new Error(`Unknown event ${event.name}`);
    try {
      if (!id.trim()) throw new Error();
      validateHeaderValue("webhook-id", id);
    } catch {
      throw new TypeError("Event id must be a non-empty header-safe string");
    }
    if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime()))
      throw new TypeError("Invalid occurredAt");
    let snapshot: unknown;
    try {
      snapshot = snapshotJson(data);
    } catch {
      throw new TypeError("Event data must be plain JSON");
    }
    const checked = await definition.payloadSchema["~standard"].validate(
      snapshot,
    );
    if (checked.issues || canonical(checked.value) !== canonical(snapshot))
      throw new TypeError(
        `Event data must match the ${event.name} payload schema unchanged`,
      );
    if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BODY_BYTES)
      throw new RangeError("Event data exceeds 256 KiB");
    const partition = definition.partitionBy
      ? definition.partitionBy.payload(snapshot as Data)
      : DEFAULT_PARTITION;
    if (typeof partition !== "string" || !partition)
      throw new Error("partitionBy.payload must return a non-empty string");
    await queue.send(
      {
        type: "fanout",
        event: event.name,
        partition,
        eventId: id,
        occurredAt: occurredAt.toISOString(),
        data: snapshot,
      },
      { idempotencyKey: hash("fanout", event.name, partition, id) },
    );
  }

  async function fanout(
    job: Extract<McpEventsJob, { type: "fanout" }>,
  ): Promise<McpEventsJobResult> {
    const event = events.get(job.event);
    if (!event) return {};
    const index = keys.event(job.event, job.partition);
    const page = await store.scanIndex(index, job.cursor, FANOUT_PAGE);
    for (const id of page.members) {
      const record = await readRecord(store, id);
      if (!record?.grant) {
        if (!record) await store.removeFromIndex(index, id);
        continue;
      }
      if (!isLive(record.grant)) {
        await store.removeFromIndex(index, id);
        continue;
      }
      if (event.match && !event.match(record.key.arguments, job.data)) continue;
      await queue.send(
        {
          type: "deliver",
          subscription: id,
          event: job.event,
          eventId: job.eventId,
          occurredAt: job.occurredAt,
          data: job.data,
        },
        { idempotencyKey: hash("deliver", id, job.eventId) },
      );
    }
    if (page.cursor !== undefined)
      await queue.send(
        { ...job, cursor: page.cursor },
        {
          idempotencyKey: hash(
            "fanout",
            job.event,
            job.partition,
            job.eventId,
            page.cursor,
          ),
        },
      );
    return {};
  }

  async function terminate(
    record: SubscriptionRecord,
    grant: Grant,
    name: EventsErrorName,
    data?: Record<string, unknown>,
  ) {
    // ChatGPT does not accept control notices; only SEP-3415 clients get one.
    if (grant.protocol === "sep-3415")
      await sendWebhookControl({
        subscription: {
          id: record.key.id,
          url: record.key.url,
          secret: grant.secret,
        },
        control: {
          type: "terminated",
          error: {
            code: errorCode("sep-3415", name),
            message: terminationMessages[name],
            ...(data ? { data } : {}),
          },
        },
        previousSecrets: liveSecrets(grant),
        network,
      }).catch(() => undefined);
    await removeRecord(store, record);
  }

  async function deliver(
    job: Extract<McpEventsJob, { type: "deliver" }>,
    attempt: number,
  ): Promise<McpEventsJobResult> {
    const event = events.get(job.event);
    const record = event ? await readRecord(store, job.subscription) : null;
    const grant = record?.grant;
    if (!event || !record || !grant) return {};
    const retry = (after?: number): McpEventsJobResult =>
      attempt < settings.maxDeliveryAttempts
        ? {
            retryAfterMs: Math.min(
              after ??
                RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1],
              MAX_RETRY_DELAY_MS,
            ),
          }
        : {};
    let outcome: WebhookResult;
    try {
      outcome = await deliverWebhookEvent({
        event,
        subscription: {
          ...record.key,
          secret: grant.secret,
          refreshBefore: grant.refreshBefore,
        },
        payload: job.data,
        eventId: job.eventId,
        timestamp: new Date(job.occurredAt),
        cursor: null,
        previousSecrets: liveSecrets(grant),
        network,
      });
    } catch (error) {
      // Schema or policy backend failures are not proof of revocation.
      options.onError?.(error, job);
      return retry();
    }
    if (outcome.ok) {
      await recordStatus(store, record.key.id, null);
      return {};
    }
    switch (outcome.reason) {
      case "forbidden":
        await terminate(record, grant, "Forbidden");
        return {};
      case "invalid_arguments":
        await terminate(record, grant, "Unsupported", {
          feature: "inputSchema",
          reason: "schema_changed",
        });
        return {};
      case "expired":
      case "invalid_subscription":
        await removeRecord(store, record);
        return {};
      case "event_mismatch":
      case "invalid_payload":
      case "payload_too_large":
        return {};
    }
    await recordStatus(store, record.key.id, statusCategory(outcome.reason));
    return outcome.retryable ? retry(outcome.retryAfterMs) : {};
  }

  const process: McpEventsJobProcessor = async (job, { attempt }) => {
    try {
      return job.type === "fanout"
        ? await fanout(job)
        : await deliver(job, attempt);
    } catch (error) {
      options.onError?.(error, job);
      throw error;
    }
  };
  queue.bind?.(process);

  return {
    register(server) {
      experimental_registerMcpEvents(server, {
        events: catalog,
        getPrincipal: options.principal,
        subscriptions,
        delivery,
        ...(options.ttl ? { ttl: options.ttl } : {}),
        ...(options.chatgptCompat !== undefined
          ? { chatgptCompat: options.chatgptCompat }
          : {}),
      });
    },
    emit,
    process,
  };
}

function liveSecrets(grant: Grant) {
  const now = Date.now();
  return grant.previousSecrets
    .filter((entry) => entry.until > now)
    .map((entry) => entry.secret);
}

/** deliveryStatus.lastError only allows the draft's categories. */
function statusCategory(
  reason: Exclude<WebhookResult, { ok: true }>["reason"],
): ExperimentalMcpWebhookFailure {
  switch (reason) {
    case "timeout":
    case "tls_error":
    case "http_4xx":
    case "http_5xx":
      return reason;
    default:
      return "connection_refused";
  }
}

function positive(value: number | undefined, fallback: number) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0)
    throw new Error("MCP Events limits must be positive integers");
  return resolved;
}
