import { randomBytes, timingSafeEqual } from "node:crypto";
import { validateHeaderValue, type ClientRequest } from "node:http";
import { request as httpsRequest, type Agent } from "node:https";
import { Webhook } from "standardwebhooks";
import { canonical } from "./json";
import {
  experimental_validateMcpEventDelivery,
  ExperimentalMcpEventDeliveryError,
} from "./validate-delivery";
import { validateSecret, validateUrl } from "./webhook-validation";
import type {
  ExperimentalMcpEventDefinition,
  ExperimentalMcpWebhookDelivery,
  ExperimentalMcpWebhookFailure,
  ExperimentalMcpWebhookSubscription,
} from "./types";

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** @experimental The outcome of one attempt; the caller owns bounded retries. */
export type ExperimentalMcpWebhookResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | Exclude<ExperimentalMcpWebhookFailure, "challenge_failed">
        | "redirect"
        | "response_too_large";
      retryable: boolean;
      status?: number;
    };

/** @experimental Load current, active subscription state before each attempt. */
export interface ExperimentalMcpEventDeliveryOptions {
  event: ExperimentalMcpEventDefinition;
  subscription: ExperimentalMcpWebhookSubscription;
  payload: unknown;
  /** Stable across retries, preferably the upstream event ID. */
  eventId: string;
  /** Occurrence time, preserved across retries (not the signing time). */
  timestamp: Date;
  /** Safe acknowledged/abandoned watermark; never use subscription.cursor. */
  cursor?: string | null;
  /** Additional trusted keys retained by the backend during a rotation grace period. */
  previousSecrets?: readonly string[];
  signal?: AbortSignal;
}

/**
 * Perform one signed endpoint-consent challenge. Use inside verifyEndpoint;
 * the adapter owns consent caching per (principal, url) and admission limits.
 * No response content is returned. Caller cancellation propagates as an error.
 *
 * @experimental HTTPS/public destinations only, including in development.
 */
export const experimental_verifyMcpWebhookEndpoint: ExperimentalMcpWebhookDelivery["verifyEndpoint"] =
  async (target, context) => {
    context.signal.throwIfAborted();
    const challenge = randomBytes(32).toString("base64url");
    const outcome = await signedPost({
      target,
      messageId: `msg_verification_${randomBytes(16).toString("hex")}`,
      body: JSON.stringify({ type: "verification", challenge }),
      signal: context.signal,
      readBody: true,
    });
    if (!outcome.ok) {
      return {
        verified: false,
        reason:
          outcome.reason === "redirect" ||
          outcome.reason === "response_too_large"
            ? "challenge_failed"
            : outcome.reason,
      };
    }
    let echoed: unknown;
    try {
      echoed = JSON.parse(outcome.body).challenge;
    } catch {
      // Malformed responses never establish consent.
    }
    const received = typeof echoed === "string" ? Buffer.from(echoed) : null;
    const expected = Buffer.from(challenge);
    return received?.length === expected.length &&
      timingSafeEqual(received, expected)
      ? { verified: true }
      : { verified: false, reason: "challenge_failed" };
  };

/**
 * Validate permissions, schemas and expiry, then sign and POST one event.
 * Validation/policy errors and caller cancellation throw. Transport failures
 * return safe categories. Does not load state, match filters, coordinate
 * cancellation with storage, compute watermarks, or schedule retries.
 *
 * @experimental HTTPS/public destinations only, including in development.
 */
export async function experimental_deliverMcpEvent({
  event,
  subscription,
  payload,
  eventId,
  timestamp,
  cursor = null,
  previousSecrets = [],
  signal,
}: ExperimentalMcpEventDeliveryOptions): Promise<ExperimentalMcpWebhookResult> {
  signal?.throwIfAborted();
  validateId(eventId);
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime()))
    throw new TypeError("Invalid event timestamp");
  if (cursor !== null && typeof cursor !== "string")
    throw new TypeError("Invalid event cursor");
  // Snapshot the JSON and routing fields so async policies cannot change what
  // will be sent after validation. Subscription records remain trusted inputs.
  let snapshot: ExperimentalMcpWebhookSubscription;
  let data: unknown;
  try {
    snapshot = {
      id: subscription.id,
      principal: subscription.principal,
      name: subscription.name,
      arguments: JSON.parse(canonical(subscription.arguments)),
      url: subscription.url,
      secret: subscription.secret,
      refreshBefore: subscription.refreshBefore,
      cursor: null,
    };
  } catch {
    throw new ExperimentalMcpEventDeliveryError("invalid_subscription");
  }
  try {
    data = JSON.parse(canonical(payload));
  } catch {
    throw new ExperimentalMcpEventDeliveryError("invalid_payload");
  }
  const occurrenceTime = timestamp.toISOString();
  const secrets = [...previousSecrets];
  await experimental_validateMcpEventDelivery({
    event,
    subscription: snapshot,
    payload: data,
    signal,
  });
  const body = JSON.stringify({
    eventId,
    name: snapshot.name,
    timestamp: occurrenceTime,
    data,
    cursor,
  });
  if (Buffer.byteLength(body) > MAX_BODY_BYTES)
    throw new RangeError("MCP event body exceeds 256 KiB");
  const outcome = await signedPost({
    target: snapshot,
    messageId: eventId,
    body,
    previousSecrets: secrets,
    signal,
    readBody: false,
    notAfter:
      snapshot.refreshBefore === null
        ? undefined
        : Date.parse(snapshot.refreshBefore),
  });
  return outcome.ok ? { ok: true } : outcome;
}

type PostResult =
  | { ok: true; body: string }
  | Extract<ExperimentalMcpWebhookResult, { ok: false }>;

// A private agent prevents consumers from weakening a shared global agent.
// No pooled sockets: every attempt passes through address validation again.
// Lazy ESM import also works from the package's CommonJS entry on Node 20.
let agentPromise: Promise<Agent> | undefined;
function getAgent(): Promise<Agent> {
  return (agentPromise ??= import("request-filtering-agent").then(
    ({ RequestFilteringHttpsAgent }) =>
      new RequestFilteringHttpsAgent({
        keepAlive: false,
        maxCachedSessions: 0,
      }),
  ));
}

function validateId(value: string): void {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError("Invalid webhook identifier");
  try {
    validateHeaderValue("webhook-id", value);
  } catch {
    throw new TypeError("Invalid webhook identifier");
  }
}

async function signedPost({
  target,
  messageId,
  body,
  previousSecrets = [],
  signal,
  readBody,
  notAfter,
}: {
  target: Pick<ExperimentalMcpWebhookSubscription, "id" | "url" | "secret">;
  messageId: string;
  body: string;
  previousSecrets?: readonly string[];
  signal?: AbortSignal;
  readBody: boolean;
  notAfter?: number;
}): Promise<PostResult> {
  // Capture before the dynamic import so the caller cannot swap destinations.
  const { id, url, secret } = target;
  validateUrl(url);
  validateId(id);
  validateId(messageId);
  const secrets = [secret, ...previousSecrets];
  if (secrets.length > 3)
    throw new RangeError("At most three signing keys are supported");
  secrets.forEach(validateSecret);
  const signers = secrets.map(
    (key) =>
      new Webhook(Buffer.from(key.slice(6), "base64"), { format: "raw" }),
  );
  signal?.throwIfAborted();
  const agent = await getAgent();
  signal?.throwIfAborted();
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
  if (notAfter !== undefined && notAfter <= Date.now())
    throw new ExperimentalMcpEventDeliveryError("expired");
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
      finish({
        ok: false,
        reason: /TLS|SSL|CERT|SELF_SIGNED|VERIFY_LEAF/.test(code)
          ? "tls_error"
          : "connection_refused",
        retryable: true,
      });
    };
    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout", retryable: true });
      req?.destroy();
    }, TIMEOUT_MS);
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
          finish({
            ok: false,
            status,
            reason:
              status >= 300 && status < 400
                ? "redirect"
                : status >= 500
                ? "http_5xx"
                : "http_4xx",
            retryable:
              status !== 410 &&
              status !== 413 &&
              (status < 300 || status >= 400),
          });
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish({
              ok: false,
              reason: "response_too_large",
              retryable: false,
              status,
            });
            res.destroy();
          } else if (readBody) chunks.push(chunk);
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
