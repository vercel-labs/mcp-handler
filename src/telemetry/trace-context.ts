import type { SpanContext } from "./otel-api";

/**
 * The client's trace context from an MCP message's `params._meta`, which
 * SEP-414 defines as the W3C `traceparent` and `tracestate` keys.
 *
 * It is read here rather than through the registered propagator: on Vercel,
 * `@vercel/otel`'s runtime propagator runs after the W3C one and replaces
 * whatever it extracted with the Vercel request's root span, so the client's
 * trace would be lost.
 */

const TRACEPARENT =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACESTATE_KEY = /^[a-z0-9][_0-9a-z\-*/@]{0,255}$/;
const TRACESTATE_VALUE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;
const MAX_TRACESTATE_ENTRIES = 32;

/**
 * A W3C `tracestate`, with the methods OpenTelemetry's `TraceState` has, so
 * SDK propagators and samplers can read and forward it.
 */
class W3CTraceState {
  constructor(private readonly entries: ReadonlyArray<[string, string]>) {}

  static parse(header: unknown): W3CTraceState | undefined {
    if (typeof header !== "string") {
      return undefined;
    }
    const entries: Array<[string, string]> = [];
    for (const member of header.split(",")) {
      const separator = member.indexOf("=");
      if (separator === -1) continue;
      const key = member.slice(0, separator).trim();
      const value = member.slice(separator + 1).trim();
      const isValid = TRACESTATE_KEY.test(key) && TRACESTATE_VALUE.test(value);
      if (isValid) {
        entries.push([key, value]);
      }
    }
    if (entries.length === 0 || entries.length > MAX_TRACESTATE_ENTRIES) {
      return undefined;
    }
    return new W3CTraceState(entries);
  }

  get(key: string): string | undefined {
    return this.entries.find(([entryKey]) => entryKey === key)?.[1];
  }

  set(key: string, value: string): W3CTraceState {
    return new W3CTraceState([
      [key, value],
      ...this.entries.filter(([entryKey]) => entryKey !== key),
    ]);
  }

  unset(key: string): W3CTraceState {
    return new W3CTraceState(
      this.entries.filter(([entryKey]) => entryKey !== key),
    );
  }

  serialize(): string {
    return this.entries.map(([key, value]) => `${key}=${value}`).join(",");
  }
}

/** The client's trace from `params._meta`, or `undefined` without a valid one. */
export function clientTraceFrom(meta: unknown): SpanContext | undefined {
  const carrier = meta as Record<string, unknown> | undefined;
  const traceparent = carrier?.traceparent;
  if (typeof traceparent !== "string") {
    return undefined;
  }
  const match = TRACEPARENT.exec(traceparent.trim());
  if (!match) {
    return undefined;
  }
  const [, version, traceId, spanId, flags] = match;
  const isValid =
    version !== "ff" && !/^0+$/.test(traceId) && !/^0+$/.test(spanId);
  if (!isValid) {
    return undefined;
  }

  const spanContext: SpanContext = {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
    isRemote: true,
  };
  const traceState = W3CTraceState.parse(carrier?.tracestate);
  if (traceState) {
    spanContext.traceState = traceState;
  }
  return spanContext;
}

export interface SpanParent {
  parentContext: unknown;
  links: Array<{ context: SpanContext }>;
}

/**
 * The parent and links of a span for MCP work: the HTTP request stays the
 * parent, and the client's trace from `params._meta` is linked.
 *
 * The MCP semantic conventions suggest the client's trace as the parent, but
 * then a client could make the server record (and bill) spans the app's own
 * sampling would drop, and a trace the client did not sample would drop the
 * message from Vercel's counts. As a link, the span is recorded exactly when
 * the request is sampled.
 */
export function selectSpanParent(
  ambientContext: unknown,
  clientTrace: SpanContext | undefined,
): SpanParent {
  const links: Array<{ context: SpanContext }> = [];
  if (clientTrace) {
    links.push({ context: clientTrace });
  }
  return { parentContext: ambientContext, links };
}
