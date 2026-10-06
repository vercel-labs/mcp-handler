import type {
  AuthInfo,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";

/** @experimental Authorization shared by subscription requests and workers. */
export interface ExperimentalMcpEventAuthorizationContext {
  /** Stable, application-defined identity, including its tenant/issuer scope. */
  principal: string;
  signal: AbortSignal;
}

/** @experimental Request-only context; never persist its access token. */
export interface ExperimentalMcpEventContext
  extends ExperimentalMcpEventAuthorizationContext {
  authInfo: AuthInfo;
}

/** @experimental A webhook event exposed through events/list. */
export interface ExperimentalMcpEventDefinition {
  name: string;
  description?: string;
  /** A non-transforming schema: arguments are part of subscription identity. */
  inputSchema: StandardSchemaWithJSON;
  payloadSchema: StandardSchemaWithJSON;
  /**
   * Authorize these filters against current permissions and application-held
   * grants. Used at subscribe time and by delivery validation, without a token.
   */
  authorize(
    args: Record<string, unknown>,
    context: ExperimentalMcpEventAuthorizationContext,
  ): boolean | Promise<boolean>;
}

/** @experimental Identity passed to storage; never supplied by the client. */
export interface ExperimentalMcpSubscriptionKey {
  id: string;
  principal: string;
  name: string;
  arguments: Record<string, unknown>;
  url: string;
}

/** @experimental A verified subscription to persist and activate atomically. */
export interface ExperimentalMcpWebhookSubscription
  extends ExperimentalMcpSubscriptionKey {
  secret: string;
  /** The granted expiry. Null requires durable state across restarts. */
  refreshBefore: string | null;
  /** Replay request, not a persisted safe delivery watermark. */
  cursor: string | null;
  maxAgeMs?: number;
}

/** @experimental Inputs for worker-side validation; no signing secret needed. */
export interface ExperimentalMcpEventDeliveryValidationOptions {
  event: ExperimentalMcpEventDefinition;
  /** Load current, active state from trusted storage before each attempt. */
  subscription:
    | Pick<
        ExperimentalMcpWebhookSubscription,
        "principal" | "name" | "arguments" | "refreshBefore"
      >
    | null
    | undefined;
  /** The event's data, not the webhook envelope. Must already match its schema. */
  payload: unknown;
  signal?: AbortSignal;
}

/** @experimental Known validation failures, distinct from backend exceptions. */
export type ExperimentalMcpEventDeliveryErrorCode =
  | "invalid_subscription"
  | "event_mismatch"
  | "expired"
  | "invalid_arguments"
  | "invalid_payload"
  | "forbidden";

/** @experimental Safe webhook diagnostics, never raw endpoint responses. */
export type ExperimentalMcpWebhookFailure =
  | "connection_refused"
  | "timeout"
  | "tls_error"
  | "http_4xx"
  | "http_5xx"
  | "challenge_failed";

/** @experimental State returned by the application's durable delivery system. */
export interface ExperimentalMcpSubscriptionState {
  /** Safe watermark, never ahead of unacknowledged deliveries; null for no replay. */
  cursor: string | null;
  truncated: boolean;
  deliveryStatus?: {
    active: boolean;
    lastDeliveryAt?: string;
    lastError: ExperimentalMcpWebhookFailure | null;
    failedSince?: string;
    throttled?: boolean;
    retryAfterMs?: number;
  };
}

/**
 * @experimental Application-owned storage and lifecycle adapter.
 *
 * Methods must be atomic/idempotent per key across concurrent HTTP requests.
 * Use an outbox or equivalent durable reconciliation for delivery activation and
 * cancellation. A request-local Map or fire-and-forget task is not sufficient.
 */
export interface ExperimentalMcpSubscriptionStore {
  /**
   * Reserve a bounded, durable operation before callback verification. Return a
   * unique, nonempty fencing token for this attempt. Supersede older attempts
   * for this key without changing any active grant, secret or delivery state.
   * Enforce admission limits here, before network work. Reservations must expire
   * and be reclaimed after failed verification, aborted requests or crashes.
   */
  prepare(
    key: ExperimentalMcpSubscriptionKey,
    context: ExperimentalMcpEventContext,
  ): Promise<string>;
  /**
   * Persist the verified grant and arrange delivery before resolving. Refresh
   * updates the secret/expiry, resumes suspended work, and applies cursor replay
   * without rewinding a live subscription. Enforce quotas here. Protect secrets
   * at rest and retain state for the entire granted lifetime. Atomically require
   * operationId to match the current, unexpired reservation before any mutation;
   * reject stale attempts, including ones invalidated by remove(). A repeated
   * commit for the same operation must converge without applying stale state.
   */
  upsert(
    subscription: ExperimentalMcpWebhookSubscription,
    context: ExperimentalMcpEventContext,
    operationId: string,
  ): Promise<ExperimentalMcpSubscriptionState>;
  /**
   * Atomically invalidate pending operations and stop delivery. Return true for
   * an existing grant or pending reservation; false only when neither exists.
   * Retain enough fencing state that delayed upserts cannot revive this key.
   */
  remove(
    key: ExperimentalMcpSubscriptionKey,
    context: ExperimentalMcpEventContext,
  ): Promise<boolean>;
}

/**
 * @experimental Adapter to the application's webhook delivery system.
 *
 * This package makes no outbound HTTP requests. The adapter must enforce its
 * egress policy on every request (including DNS resolution), disable redirects,
 * and bound timeouts/response sizes. Cache consent per (principal, url), rate
 * limit failed verifications, and honor the abort signal.
 */
export interface ExperimentalMcpWebhookDelivery {
  /**
   * Prove endpoint consent using a signed verification challenge or another
   * mechanism allowed by the draft before any subscription is activated. Use a
   * vetted Standard Webhooks implementation for signing; true must never mean
   * merely that the URL was reachable. The delivery worker behind the store must
   * sign events/controls, enforce expiry/revocation, and retry durably.
   */
  verifyEndpoint(
    target: ExperimentalMcpSubscriptionKey & { secret: string },
    context: ExperimentalMcpEventContext,
  ): Promise<
    | { verified: true }
    | { verified: false; reason: ExperimentalMcpWebhookFailure }
  >;
}

/** @experimental Options for experimental_registerMcpEvents. */
export interface ExperimentalMcpEventsOptions {
  /** Resolve only from verified AuthInfo; do not use clientId as an end-user ID. */
  getPrincipal(authInfo: AuthInfo): string | Promise<string>;
  /** Use a resolver when the catalog depends on the authenticated account. */
  events:
    | readonly ExperimentalMcpEventDefinition[]
    | ((
        context: ExperimentalMcpEventContext,
      ) =>
        | readonly ExperimentalMcpEventDefinition[]
        | Promise<readonly ExperimentalMcpEventDefinition[]>);
  subscriptions: ExperimentalMcpSubscriptionStore;
  delivery: ExperimentalMcpWebhookDelivery;
  ttl?: {
    /** @default 60000 */
    minMs?: number;
    /** @default 3600000 */
    defaultMs?: number;
    /** @default 86400000 */
    maxMs?: number;
    /** Enable only with durable no-expiry storage/delivery. @default false */
    allowNoExpiry?: boolean;
  };
}
