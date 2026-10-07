import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { canonical } from "./json";
import type {
  ExperimentalMcpEventDeliveryErrorCode,
  ExperimentalMcpEventDeliveryValidationOptions,
} from "./types";

const messages: Record<ExperimentalMcpEventDeliveryErrorCode, string> = {
  invalid_subscription: "A valid stored subscription is required",
  event_mismatch: "Event definition does not match the subscription",
  expired: "Subscription has expired",
  invalid_arguments: "Stored arguments must match the event schema unchanged",
  invalid_payload: "Payload must be JSON matching the event schema unchanged",
  forbidden: "Subscription principal is no longer authorized",
};

/** @experimental A validation failure; contains no payload or credentials. */
export class ExperimentalMcpEventDeliveryError extends Error {
  constructor(public readonly code: ExperimentalMcpEventDeliveryErrorCode) {
    super(messages[code]);
    this.name = "ExperimentalMcpEventDeliveryError";
  }
}

/**
 * Validate a candidate event against a current stored subscription. Resolves
 * without modifying/transforming the payload, or throws to prevent delivery.
 *
 * @experimental Does not load state, match source events to filters, sign/send,
 * or coordinate cancellation. The worker must gate dispatch on active state.
 * Authorization/schema backend exceptions and abort reasons propagate unchanged.
 */
export async function experimental_validateMcpEventDelivery({
  event,
  subscription,
  payload,
  signal = new AbortController().signal,
}: ExperimentalMcpEventDeliveryValidationOptions): Promise<void> {
  signal.throwIfAborted();
  if (
    !subscription ||
    typeof subscription.principal !== "string" ||
    !subscription.principal.trim() ||
    typeof subscription.name !== "string" ||
    !subscription.name ||
    !subscription.arguments ||
    typeof subscription.arguments !== "object" ||
    Array.isArray(subscription.arguments)
  )
    throw new ExperimentalMcpEventDeliveryError("invalid_subscription");
  if (event.name !== subscription.name)
    throw new ExperimentalMcpEventDeliveryError("event_mismatch");

  const expiry =
    subscription.refreshBefore === null
      ? null
      : typeof subscription.refreshBefore === "string"
      ? Date.parse(subscription.refreshBefore)
      : NaN;
  if (expiry !== null && !Number.isFinite(expiry))
    throw new ExperimentalMcpEventDeliveryError("invalid_subscription");

  function checkLifetime() {
    signal.throwIfAborted();
    if (expiry !== null && expiry <= Date.now())
      throw new ExperimentalMcpEventDeliveryError("expired");
  }
  checkLifetime();
  await validateUnchanged(
    event.inputSchema,
    subscription.arguments,
    "invalid_arguments",
  );
  checkLifetime();
  await validateUnchanged(event.payloadSchema, payload, "invalid_payload");
  checkLifetime();
  const authorized = await event.authorize(subscription.arguments, {
    principal: subscription.principal,
    signal,
  });
  // Async schema/policy checks can outlive the grant or worker cancellation.
  checkLifetime();
  if (authorized !== true)
    throw new ExperimentalMcpEventDeliveryError("forbidden");
}

async function validateUnchanged(
  schema: StandardSchemaWithJSON,
  value: unknown,
  code: "invalid_arguments" | "invalid_payload",
): Promise<void> {
  function json(input: unknown) {
    try {
      return canonical(input);
    } catch {
      throw new ExperimentalMcpEventDeliveryError(code);
    }
  }
  const before = json(value);
  const result = await schema["~standard"].validate(value);
  if (result.issues || json(result.value) !== before || json(value) !== before)
    throw new ExperimentalMcpEventDeliveryError(code);
}
