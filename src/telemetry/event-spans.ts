import { ProtocolError } from "@modelcontextprotocol/server";
import { rpcErrorOutcome } from "./attributes";
import {
  SPAN_KIND_CLIENT,
  SPAN_KIND_INTERNAL,
  SPAN_STATUS_ERROR,
  type Attributes,
  type McpTracing,
} from "./otel-api";

/**
 * Spans for the MCP Events control methods: one per subscription change the
 * application's store makes, and one per callback verification. They follow
 * the `mcp.event.*` names and `vercel.mcp.*` attributes Vercel MCP uses.
 *
 * They are `INTERNAL` and `CLIENT` spans without `mcp.method.name`, so Vercel
 * never counts them as MCP messages. Callback URLs, subscription IDs, secrets,
 * arguments and error messages are never recorded.
 */

export const VERCEL_MCP_EVENT_ATTRIBUTES = {
  eventType: "vercel.mcp.event.type",
  eventOutcome: "vercel.mcp.event.outcome",
  subscriptionAction: "vercel.mcp.subscription.action",
  subscriptionOutcome: "vercel.mcp.subscription.outcome",
} as const;

/** What the event spans of one server need: a tracer and the caller. */
export interface EventTelemetry {
  tracing: McpTracing;
  attributes: Attributes;
}

export type SubscriptionAction = "prepare" | "subscribe" | "unsubscribe";

type StepResult = { outcome: string; errorType?: string };

const EVENT_NAME = /^[A-Za-z0-9_.:/-]{1,128}$/;

/**
 * An event name from the application's catalog. Names are registered, but an
 * unusual one still becomes `other` so no raw string reaches an attribute.
 */
export function eventTypeAttributes(name: string): Attributes {
  let eventType = "other";
  if (EVENT_NAME.test(name)) {
    eventType = name;
  }
  return { [VERCEL_MCP_EVENT_ATTRIBUTES.eventType]: eventType };
}

/** A short `error.type` for a failed step; never the message. */
function eventErrorType(error: unknown): string {
  const isAbort = error instanceof Error && error.name === "AbortError";
  if (isAbort) {
    return "cancelled";
  }
  if (error instanceof ProtocolError) {
    return rpcErrorOutcome(error.code).errorType;
  }
  return "internal_error";
}

/**
 * Runs one step and writes its span in one step once the outcome is known, as
 * the message spans do: `@vercel/otel` ends every open span of a trace when
 * the first span it recorded there ends.
 */
async function recordStep<T>(
  telemetry: EventTelemetry | undefined,
  span: { name: string; kind: number; attributes: Attributes; outcomeKey: string },
  run: () => Promise<T>,
  describe: (result: T) => StepResult,
): Promise<T> {
  if (!telemetry) {
    return run();
  }

  const startTime = Date.now();
  const parentContext = telemetry.tracing.activeContext();
  let step: Partial<StepResult> = {};
  try {
    const result = await run();
    step = describe(result);
    return result;
  } catch (error) {
    step = { errorType: eventErrorType(error) };
    throw error;
  } finally {
    const attributes: Attributes = {
      ...telemetry.attributes,
      ...span.attributes,
    };
    if (step.outcome) {
      attributes[span.outcomeKey] = step.outcome;
    }
    if (step.errorType) {
      attributes["error.type"] = step.errorType;
    }
    try {
      const written = telemetry.tracing.tracer.startSpan(
        span.name,
        { kind: span.kind, startTime, attributes },
        parentContext,
      );
      if (step.errorType) {
        written.setStatus({ code: SPAN_STATUS_ERROR });
      }
      written.end();
    } catch {
      // A span must never change the server's answer.
    }
  }
}

/**
 * A span for one subscription change the application's store makes, named
 * `mcp.event.subscription {action}`.
 */
export function recordSubscriptionChange<T>(
  telemetry: EventTelemetry | undefined,
  action: SubscriptionAction,
  attributes: Attributes,
  run: () => Promise<T>,
  describe: (result: T) => StepResult,
): Promise<T> {
  return recordStep(
    telemetry,
    {
      name: `mcp.event.subscription ${action}`,
      kind: SPAN_KIND_INTERNAL,
      attributes: {
        ...attributes,
        [VERCEL_MCP_EVENT_ATTRIBUTES.subscriptionAction]: action,
      },
      outcomeKey: VERCEL_MCP_EVENT_ATTRIBUTES.subscriptionOutcome,
    },
    run,
    describe,
  );
}

/** A span for one callback verification, named `mcp.event.verify_callback`. */
export function recordCallbackVerification<T>(
  telemetry: EventTelemetry | undefined,
  attributes: Attributes,
  run: () => Promise<T>,
  describe: (result: T) => StepResult,
): Promise<T> {
  return recordStep(
    telemetry,
    {
      name: "mcp.event.verify_callback",
      kind: SPAN_KIND_CLIENT,
      attributes,
      outcomeKey: VERCEL_MCP_EVENT_ATTRIBUTES.eventOutcome,
    },
    run,
    describe,
  );
}
