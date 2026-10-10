import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { validateHeaderValue, type ClientRequest } from "node:http";
import { request as httpsRequest, type Agent } from "node:https";
import { isIP } from "node:net";
import { Webhook } from "standardwebhooks";
import { snapshotJson } from "./json";
import {
  experimental_validateMcpEventDelivery,
  ExperimentalMcpEventDeliveryError,
} from "./validate-delivery";
import { isValidCallbackUrl, isValidWebhookSecret } from "./webhook-validation";
import type {
  ExperimentalMcpEventContext,
  ExperimentalMcpEventDefinition,
  ExperimentalMcpEventDeliveryErrorCode,
  ExperimentalMcpWebhookDelivery,
  ExperimentalMcpWebhookFailure,
  ExperimentalMcpWebhookSubscription,
} from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_PREVIOUS_SECRETS = 2;

/** @experimental Egress settings shared by the webhook helpers. */
export interface WebhookNetworkOptions {
  /**
   * Private or special-use IPs/CIDRs to permit, such as a private-cloud
   * receiver or a local test endpoint. Every other non-public address stays
   * blocked, and TLS certificates are still verified.
   */
  allowIPAddressList?: readonly string[];
  /** Total deadline for each request, including DNS and TLS. @default 10000 */
  timeoutMs?: number;
}

/** @experimental Why a request failed in transit; never endpoint content. */
export type WebhookTransportFailure =
  | Exclude<ExperimentalMcpWebhookFailure, "challenge_failed">
  | "redirect"
  | "blocked_destination";

/** @experimental Why nothing was sent; retrying the same input cannot help. */
export type WebhookRejection =
  | ExperimentalMcpEventDeliveryErrorCode
  | "payload_too_large";

/** @experimental The outcome of one attempt; the caller owns bounded retries. */
export type WebhookResult =
  | { ok: true }
  | {
      ok: false;
      reason: WebhookTransportFailure;
      retryable: boolean;
      status?: number;
      /** From the endpoint's Retry-After header, on retryable HTTP failures. */
      retryAfterMs?: number;
    }
  | { ok: false; reason: WebhookRejection; retryable: false };

/** @experimental Load current, active subscription state before each attempt. */
export interface WebhookEventDeliveryOptions {
  event: ExperimentalMcpEventDefinition;
  subscription: Pick<
    ExperimentalMcpWebhookSubscription,
    | "id"
    | "principal"
    | "name"
    | "arguments"
    | "url"
    | "secret"
    | "refreshBefore"
  >;
  payload: unknown;
  /** Stable across retries, preferably the upstream event ID. */
  eventId: string;
  /** Occurrence time, preserved across retries (not the signing time). */
  timestamp: Date;
  /** Safe acknowledged/abandoned watermark, not the requested replay cursor. */
  cursor?: string | null;
  /** Up to two keys still trusted during a secret rotation grace period. */
  previousSecrets?: readonly string[];
  network?: WebhookNetworkOptions;
  signal?: AbortSignal;
}

/** @experimental A non-event notice defined by the draft. */
export type WebhookControl =
  | { type: "gap"; cursor: string }
  | {
      type: "terminated";
      error: { code: number; message: string; data?: unknown };
    };

/** @experimental Load current subscription state before each attempt. */
export interface WebhookControlOptions {
  subscription: Pick<
    ExperimentalMcpWebhookSubscription,
    "id" | "url" | "secret"
  >;
  control: WebhookControl;
  /** Up to two keys still trusted during a secret rotation grace period. */
  previousSecrets?: readonly string[];
  network?: WebhookNetworkOptions;
  signal?: AbortSignal;
}

/**
 * Perform one signed endpoint-consent challenge. Usable directly as
 * verifyEndpoint; the adapter owns consent caching per (principal, url) and
 * admission limits. No response content is returned. Invalid targets throw a
 * TypeError and caller cancellation propagates as an error.
 *
 * @experimental HTTPS/public destinations only unless network allows others.
 */
export async function verifyWebhookEndpoint(
  target: Pick<ExperimentalMcpWebhookSubscription, "id" | "url" | "secret">,
  context: Pick<ExperimentalMcpEventContext, "signal">,
  network?: WebhookNetworkOptions,
): ReturnType<ExperimentalMcpWebhookDelivery["verifyEndpoint"]> {
  context.signal.throwIfAborted();
  const settings = networkSettings(network);
  const { id, url, secret } = target;
  if (
    !isWebhookId(id) ||
    !isValidCallbackUrl(url) ||
    !isValidWebhookSecret(secret)
  )
    throw new TypeError("Invalid webhook verification target");
  const challenge = randomBytes(32).toString("base64url");
  const outcome = await signedPost({
    id,
    url,
    secrets: [secret],
    messageId: `msg_verification_${randomBytes(16).toString("hex")}`,
    body: JSON.stringify({ type: "verification", challenge }),
    readBody: true,
    settings,
    signal: context.signal,
  });
  if (!outcome.ok)
    return { verified: false, reason: verificationFailure(outcome.reason) };
  let echoed: unknown;
  try {
    if (outcome.body !== null) echoed = JSON.parse(outcome.body).challenge;
  } catch {
    // Malformed responses never establish consent.
  }
  const received = typeof echoed === "string" ? Buffer.from(echoed) : null;
  const expected = Buffer.from(challenge);
  return received?.length === expected.length &&
    timingSafeEqual(received, expected)
    ? { verified: true }
    : { verified: false, reason: "challenge_failed" };
}

/**
 * Validate permissions, schemas and expiry, then sign and POST one event.
 * Every known outcome resolves: rejections (nothing sent) and transport
 * failures are categorized results. Malformed arguments throw a TypeError;
 * schema/policy backend exceptions and caller cancellation propagate. Does not
 * load state, match filters, coordinate cancellation with storage, compute
 * watermarks, or schedule retries.
 *
 * @experimental HTTPS/public destinations only unless network allows others.
 */
export async function deliverWebhookEvent({
  event,
  subscription,
  payload,
  eventId,
  timestamp,
  cursor = null,
  previousSecrets = [],
  network,
  signal,
}: WebhookEventDeliveryOptions): Promise<WebhookResult> {
  signal?.throwIfAborted();
  if (!isWebhookId(eventId)) throw new TypeError("Invalid webhook identifier");
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime()))
    throw new TypeError("Invalid event timestamp");
  if (cursor !== null && typeof cursor !== "string")
    throw new TypeError("Invalid event cursor");
  const settings = networkSettings(network);
  // Snapshot the JSON and routing fields so async policies cannot change what
  // will be sent after validation. Subscription records remain trusted inputs.
  const { id, principal, name, url, refreshBefore } = subscription;
  const secrets = signingKeys(subscription.secret, previousSecrets);
  let args: unknown;
  let data: unknown;
  try {
    args = snapshotJson(subscription.arguments);
  } catch {
    return rejected("invalid_subscription");
  }
  if (
    !isWebhookId(id) ||
    !isValidCallbackUrl(url) ||
    !secrets.every(isValidWebhookSecret)
  )
    return rejected("invalid_subscription");
  try {
    data = snapshotJson(payload);
  } catch {
    return rejected("invalid_payload");
  }
  const body = JSON.stringify({
    eventId,
    name,
    timestamp: timestamp.toISOString(),
    data,
    cursor,
  });
  // Checked before policy calls: no authorization can make this sendable.
  if (Buffer.byteLength(body) > MAX_BODY_BYTES)
    return rejected("payload_too_large");
  try {
    await experimental_validateMcpEventDelivery({
      event,
      subscription: {
        principal,
        name,
        arguments: args as Record<string, unknown>,
        refreshBefore,
      },
      payload: data,
      signal,
    });
  } catch (error) {
    if (error instanceof ExperimentalMcpEventDeliveryError)
      return rejected(error.code);
    throw error;
  }
  const outcome = await signedPost({
    id,
    url,
    secrets,
    messageId: eventId,
    body,
    readBody: false,
    settings,
    signal,
    notAfter: refreshBefore === null ? undefined : Date.parse(refreshBefore),
  });
  return outcome.ok ? { ok: true } : outcome;
}

/**
 * Sign and POST one `gap` or `terminated` notice. No authorization or expiry
 * checks run: `terminated` is often sent because access was revoked. Retries
 * of the same notice reuse the same `webhook-id`. Results and errors follow
 * deliverWebhookEvent.
 *
 * @experimental HTTPS/public destinations only unless network allows others.
 */
export async function sendWebhookControl({
  subscription,
  control,
  previousSecrets = [],
  network,
  signal,
}: WebhookControlOptions): Promise<WebhookResult> {
  signal?.throwIfAborted();
  const { type, body } = controlBody(control);
  const settings = networkSettings(network);
  const { id, url } = subscription;
  const secrets = signingKeys(subscription.secret, previousSecrets);
  if (
    !isWebhookId(id) ||
    !isValidCallbackUrl(url) ||
    !secrets.every(isValidWebhookSecret)
  )
    return rejected("invalid_subscription");
  if (Buffer.byteLength(body) > MAX_BODY_BYTES)
    return rejected("payload_too_large");
  // The draft's msg_<type>_<random> form; a digest stays stable across retries.
  const digest = createHash("sha256")
    .update(`${id}\n${body}`)
    .digest("hex")
    .slice(0, 32);
  const outcome = await signedPost({
    id,
    url,
    secrets,
    messageId: `msg_${type}_${digest}`,
    body,
    readBody: false,
    settings,
    signal,
  });
  return outcome.ok ? { ok: true } : outcome;
}

type NetworkSettings = { allowIPAddressList: string[]; timeoutMs: number };

type PostResult =
  // body is null when a challenge response exceeds the size limit.
  { ok: true; body: string | null } | Exclude<WebhookResult, { ok: true }>;

function rejected(reason: WebhookRejection) {
  return { ok: false, reason, retryable: false } as const;
}

function verificationFailure(
  reason: Exclude<PostResult, { ok: true }>["reason"],
): ExperimentalMcpWebhookFailure {
  switch (reason) {
    case "connection_refused":
    case "timeout":
    case "tls_error":
    case "http_4xx":
    case "http_5xx":
      return reason;
    // The draft reports refused destinations as unreachable.
    case "blocked_destination":
      return "connection_refused";
    default:
      return "challenge_failed";
  }
}

function networkSettings(
  network: WebhookNetworkOptions | undefined,
): NetworkSettings {
  const timeoutMs = network?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowList = network?.allowIPAddressList ?? [];
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Array.isArray(allowList) ||
    !allowList.every(isIPOrCIDR)
  )
    throw new TypeError("Invalid webhook network options");
  return { timeoutMs, allowIPAddressList: [...allowList] };
}

function isIPOrCIDR(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const [address, prefix, ...rest] = value.split("/");
  const family = isIP(address);
  return (
    family !== 0 &&
    rest.length === 0 &&
    (prefix === undefined ||
      (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)))
  );
}

function signingKeys(
  secret: string,
  previousSecrets: readonly string[],
): string[] {
  if (
    !Array.isArray(previousSecrets) ||
    previousSecrets.length > MAX_PREVIOUS_SECRETS
  )
    throw new TypeError("At most two previous secrets are supported");
  return [secret, ...previousSecrets];
}

function controlBody(control: WebhookControl): {
  type: string;
  body: string;
} {
  if (
    control?.type === "gap" &&
    typeof control.cursor === "string" &&
    control.cursor
  )
    return {
      type: "gap",
      body: JSON.stringify({ type: "gap", cursor: control.cursor }),
    };
  if (control?.type === "terminated") {
    const { code, message, data } = control.error ?? {};
    if (Number.isSafeInteger(code) && typeof message === "string") {
      try {
        const error = {
          code,
          message,
          ...(data !== undefined ? { data: snapshotJson(data) } : {}),
        };
        return {
          type: "terminated",
          body: JSON.stringify({ type: "terminated", error }),
        };
      } catch {
        // Fall through: data must be plain JSON.
      }
    }
  }
  throw new TypeError("Invalid webhook control");
}

function isWebhookId(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    validateHeaderValue("webhook-id", value);
    return true;
  } catch {
    return false;
  }
}

function retryAfterMs(
  value: string | string[] | undefined,
): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const ms = /^\d+$/.test(trimmed)
    ? Number(trimmed) * 1000
    : Date.parse(trimmed) - Date.now();
  return Number.isSafeInteger(ms) ? Math.max(0, ms) : undefined;
}

// A private agent per attempt prevents consumers from weakening a shared global
// agent, and nothing is pooled: every attempt passes address validation again.
// Lazy ESM import also works from the package's CommonJS entry on Node 20.
let agentModule: Promise<typeof import("request-filtering-agent")> | undefined;
async function createAgent({
  allowIPAddressList,
}: NetworkSettings): Promise<Agent> {
  agentModule ??= import("request-filtering-agent").catch((error) => {
    // Let a later attempt retry a failed load instead of caching the failure.
    agentModule = undefined;
    throw error;
  });
  const { RequestFilteringHttpsAgent } = await agentModule;
  return new RequestFilteringHttpsAgent({
    keepAlive: false,
    maxCachedSessions: 0,
    allowIPAddressList,
  });
}

// request-filtering-agent rejects addresses with uncoded errors of this form.
const BLOCKED_ADDRESS = /^DNS lookup .* is not allowed\./;

async function signedPost({
  id,
  url,
  secrets,
  messageId,
  body,
  readBody,
  settings,
  signal,
  notAfter,
}: {
  id: string;
  url: string;
  secrets: readonly string[];
  messageId: string;
  body: string;
  readBody: boolean;
  settings: NetworkSettings;
  signal?: AbortSignal;
  notAfter?: number;
}): Promise<PostResult> {
  const signers = secrets.map(
    (key) =>
      new Webhook(Buffer.from(key.slice(6), "base64"), { format: "raw" }),
  );
  signal?.throwIfAborted();
  const agent = await createAgent(settings);
  signal?.throwIfAborted();
  if (notAfter !== undefined && notAfter <= Date.now())
    return rejected("expired");
  const now = new Date();
  const headers = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "webhook-id": messageId,
    "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
    "webhook-signature": signers
      .map((signer) => signer.sign(messageId, now, body))
      .join(" "),
    "x-mcp-subscription-id": id,
  };
  return new Promise<PostResult>((resolve, reject) => {
    let req: ClientRequest | undefined;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (result: PostResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal!.reason);
      req?.destroy();
    };
    const fail = (error?: NodeJS.ErrnoException) => {
      const code = error?.code ?? "";
      finish(
        !code && BLOCKED_ADDRESS.test(error?.message ?? "")
          ? { ok: false, reason: "blocked_destination", retryable: false }
          : {
              ok: false,
              reason: /TLS|SSL|CERT|SELF_SIGNED|VERIFY_LEAF/.test(code)
                ? "tls_error"
                : "connection_refused",
              retryable: true,
            },
      );
    };
    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout", retryable: true });
      req?.destroy();
    }, settings.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      // node:https does not follow redirects and keeps the URL hostname for TLS.
      req = httpsRequest(url, { method: "POST", agent, headers }, (res) => {
        const status = res.statusCode ?? 0;
        res.on("error", fail);
        res.on("close", () => {
          if (!res.complete) fail();
        });
        if (status < 200 || status >= 300) {
          const retryable =
            status !== 410 && status !== 413 && (status < 300 || status >= 400);
          const delay = retryable
            ? retryAfterMs(res.headers["retry-after"])
            : undefined;
          finish({
            ok: false,
            status,
            reason:
              status >= 300 && status < 400
                ? "redirect"
                : status >= 500
                ? "http_5xx"
                : "http_4xx",
            retryable,
            ...(delay !== undefined ? { retryAfterMs: delay } : {}),
          });
          res.destroy();
          return;
        }
        // A 2xx status is the acknowledgement; only challenges need the body.
        if (!readBody) {
          finish({ ok: true, body: "" });
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish({ ok: true, body: null });
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on("end", () =>
          finish({ ok: true, body: Buffer.concat(chunks).toString("utf8") }),
        );
      });
      req.on("error", fail);
      req.end(body);
    } catch {
      fail();
      req?.destroy();
    }
  });
}
