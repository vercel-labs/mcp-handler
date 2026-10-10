import { createHash, randomUUID } from "node:crypto";
import { ProtocolError } from "@modelcontextprotocol/server";
import { verifyWebhookEndpoint, type WebhookNetworkOptions } from "../webhook";
import type { ExperimentalMcpEventsDialect } from "../protocol";
import type {
  ExperimentalMcpSubscriptionKey,
  ExperimentalMcpSubscriptionState,
  ExperimentalMcpSubscriptionStore,
  ExperimentalMcpWebhookDelivery,
  ExperimentalMcpWebhookFailure,
} from "../types";
import type { McpEvent } from "./define";
import type { McpEventsStore } from "./store";

/** A verified grant; only `upsert` with a matching operation creates one. */
export interface Grant {
  secret: string;
  previousSecrets: { secret: string; until: number }[];
  refreshBefore: string | null;
  protocol: ExperimentalMcpEventsDialect;
  operation: string;
}

export interface SubscriptionRecord {
  key: ExperimentalMcpSubscriptionKey;
  partition: string;
  pending?: { operation: string; until: number };
  grant?: Grant;
}

export interface DeliveryStatus {
  lastDeliveryAt?: string;
  lastError: ExperimentalMcpWebhookFailure | null;
  failedSince?: string;
}

export const DEFAULT_PARTITION = "*";
const RESERVATION_MS = 60_000;
const RETENTION_GRACE_MS = 60_000;
const STATUS_TTL_MS = 7 * 86_400_000;
const MAX_CONFLICTS = 10;

export const keys = {
  subscription: (id: string) => `sub:${id}`,
  status: (id: string) => `status:${id}`,
  event: (name: string, partition: string) =>
    `event:${encodeURIComponent(name)}:${encodeURIComponent(partition)}`,
  principal: (principal: string) =>
    `principal:${encodeURIComponent(principal)}`,
  consent: (principal: string, url: string) =>
    `consent:${hash(principal, url)}`,
  rate: (...parts: string[]) =>
    `rate:${hash(...parts)}:${Math.floor(Date.now() / 60_000)}`,
};

export function hash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export function isLive(grant: Grant | undefined, now = Date.now()) {
  return (
    grant !== undefined &&
    (grant.refreshBefore === null || Date.parse(grant.refreshBefore) > now)
  );
}

export async function readRecord(store: McpEventsStore, id: string) {
  const entry = await store.get(keys.subscription(id));
  return entry ? (JSON.parse(entry.value) as SubscriptionRecord) : null;
}

/** Read-modify-write one JSON value under compare-and-set, retrying conflicts. */
export async function update<T, R>(
  store: McpEventsStore,
  key: string,
  change: (current: T | null) => { value: T; ttlMs?: number; result: R } | R,
  isWrite: (
    outcome: { value: T; ttlMs?: number; result: R } | R,
  ) => outcome is { value: T; ttlMs?: number; result: R },
): Promise<R> {
  for (let attempt = 0; attempt < MAX_CONFLICTS; attempt++) {
    const entry = await store.get(key);
    const outcome = change(entry ? (JSON.parse(entry.value) as T) : null);
    if (!isWrite(outcome)) return outcome;
    const written = await store.put(key, JSON.stringify(outcome.value), {
      version: entry?.version ?? null,
      ...(outcome.ttlMs !== undefined ? { ttlMs: outcome.ttlMs } : {}),
    });
    if (written) return outcome.result;
  }
  throw new Error("Too many concurrent subscription updates");
}

function recordTtl(record: SubscriptionRecord, now: number) {
  const until = [
    record.pending?.until,
    record.grant
      ? record.grant.refreshBefore === null
        ? Infinity
        : Date.parse(record.grant.refreshBefore)
      : undefined,
  ].filter((value): value is number => value !== undefined);
  const latest = Math.max(...until);
  return latest === Infinity
    ? undefined
    : Math.max(1, latest - now + RETENTION_GRACE_MS);
}

export async function removeRecord(
  store: McpEventsStore,
  record: SubscriptionRecord,
) {
  await store.delete(keys.subscription(record.key.id));
  await Promise.all([
    store.removeFromIndex(
      keys.event(record.key.name, record.partition),
      record.key.id,
    ),
    store.removeFromIndex(keys.principal(record.key.principal), record.key.id),
    store.delete(keys.status(record.key.id)),
  ]);
}

export async function recordStatus(
  store: McpEventsStore,
  id: string,
  failure: ExperimentalMcpWebhookFailure | null,
) {
  const now = new Date().toISOString();
  await update<DeliveryStatus, void>(
    store,
    keys.status(id),
    (current) => ({
      value:
        failure === null
          ? { lastDeliveryAt: now, lastError: null }
          : {
              ...(current?.lastDeliveryAt
                ? { lastDeliveryAt: current.lastDeliveryAt }
                : {}),
              lastError: failure,
              failedSince: current?.failedSince ?? now,
            },
      ttlMs: STATUS_TTL_MS,
      result: undefined,
    }),
    (outcome): outcome is { value: DeliveryStatus; result: void } =>
      outcome !== undefined,
  );
}

export interface SubscriptionSettings {
  store: McpEventsStore;
  events: ReadonlyMap<string, McpEvent>;
  subscriptionsPerPrincipal: number;
  secretRotationGraceMs: number;
}

const write = <T, R>(
  outcome: { value: T; ttlMs?: number; result: R } | R,
): outcome is { value: T; ttlMs?: number; result: R } =>
  typeof outcome === "object" && outcome !== null && "value" in outcome;

/** The fenced prepare/upsert/remove contract, implemented once over the store. */
export function storeSubscriptions({
  store,
  events,
  subscriptionsPerPrincipal,
  secretRotationGraceMs,
}: SubscriptionSettings): ExperimentalMcpSubscriptionStore {
  function partitionOf(key: ExperimentalMcpSubscriptionKey) {
    const event = events.get(key.name);
    const partition = event?.partitionBy
      ? event.partitionBy.arguments(key.arguments)
      : DEFAULT_PARTITION;
    if (typeof partition !== "string" || !partition)
      throw new Error("partitionBy.arguments must return a non-empty string");
    return partition;
  }

  async function liveSubscriptions(principal: string, except: string) {
    const index = keys.principal(principal);
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await store.scanIndex(index, cursor, 100);
      for (const id of page.members) {
        if (id === except) continue;
        const record = await readRecord(store, id);
        if (!record) await store.removeFromIndex(index, id);
        else if (isLive(record.grant) || record.pending) count++;
      }
      cursor = page.cursor;
    } while (cursor !== undefined && count < subscriptionsPerPrincipal);
    return count;
  }

  return {
    async prepare(key) {
      const partition = partitionOf(key);
      if (
        (await liveSubscriptions(key.principal, key.id)) >=
        subscriptionsPerPrincipal
      )
        throw new ProtocolError(-32013, "Subscription limit reached");
      const operation = randomUUID();
      await update<SubscriptionRecord, void>(
        store,
        keys.subscription(key.id),
        (current) => {
          const now = Date.now();
          const record: SubscriptionRecord = {
            ...(current ?? {}),
            key,
            partition,
            pending: { operation, until: now + RESERVATION_MS },
          };
          return {
            value: record,
            ttlMs: recordTtl(record, now),
            result: undefined,
          };
        },
        write,
      );
      await store.addToIndex(keys.principal(key.principal), key.id);
      return operation;
    },

    async upsert(subscription, _context, operation) {
      const {
        secret,
        refreshBefore,
        cursor,
        protocol = "chatgpt",
      } = subscription;
      const key: ExperimentalMcpSubscriptionKey = {
        id: subscription.id,
        principal: subscription.principal,
        name: subscription.name,
        arguments: subscription.arguments,
        url: subscription.url,
      };
      const record = await update<SubscriptionRecord, SubscriptionRecord>(
        store,
        keys.subscription(key.id),
        (current) => {
          const now = Date.now();
          // A repeated commit of the same operation converges on its grant.
          if (current?.grant?.operation === operation) return current;
          if (
            !current?.pending ||
            current.pending.operation !== operation ||
            current.pending.until <= now
          )
            throw new Error("Subscription operation superseded");
          const previous = current.grant;
          const previousSecrets = [
            ...(previous && previous.secret !== secret
              ? [
                  {
                    secret: previous.secret,
                    until: now + secretRotationGraceMs,
                  },
                ]
              : []),
            ...(previous?.previousSecrets ?? []),
          ]
            .filter((entry) => entry.until > now && entry.secret !== secret)
            .slice(0, 2);
          const next: SubscriptionRecord = {
            key,
            partition: current.partition,
            grant: {
              secret,
              previousSecrets,
              refreshBefore,
              protocol,
              operation,
            },
          };
          return { value: next, ttlMs: recordTtl(next, now), result: next };
        },
        write,
      );
      await store.addToIndex(keys.event(key.name, record.partition), key.id);
      const status = await store.get(keys.status(key.id));
      const delivery = status
        ? (JSON.parse(status.value) as DeliveryStatus)
        : undefined;
      // No replay: a requested position cannot be resumed, so report a gap.
      const state: ExperimentalMcpSubscriptionState = {
        cursor: null,
        truncated: cursor !== null,
        ...(delivery ? { deliveryStatus: { active: true, ...delivery } } : {}),
      };
      return state;
    },

    async remove(key) {
      const record = await readRecord(store, key.id);
      if (!record) return false;
      // Deleting the record also invalidates any pending operation: a late
      // upsert finds no reservation and fails.
      await removeRecord(store, record);
      return true;
    },
  };
}

export interface VerificationSettings {
  store: McpEventsStore;
  network?: WebhookNetworkOptions;
  consentTtlMs: number;
  verificationsPerMinute: number;
  hostVerificationsPerMinute: number;
}

/** Cache consent per (principal, url) and bound verification POSTs per host. */
export function cachedVerification({
  store,
  network,
  consentTtlMs,
  verificationsPerMinute,
  hostVerificationsPerMinute,
}: VerificationSettings): ExperimentalMcpWebhookDelivery {
  return {
    async verifyEndpoint(target, context) {
      const consent = keys.consent(context.principal, target.url);
      if (await store.get(consent)) return { verified: true };
      const host = new URL(target.url).hostname;
      // Shared receivers (ChatGPT uses one callback host) need a higher host cap.
      const [perPrincipal, perHost] = await Promise.all([
        store.increment(keys.rate("verify", context.principal, host), 60_000),
        store.increment(keys.rate("verify", host), 60_000),
      ]);
      if (
        perPrincipal > verificationsPerMinute ||
        perHost > hostVerificationsPerMinute
      )
        throw new ProtocolError(-32013, "Verification rate limit reached");
      const result = await verifyWebhookEndpoint(target, context, network);
      if (result.verified)
        await store.put(consent, "1", { version: null, ttlMs: consentTtlMs });
      return result;
    },
  };
}
