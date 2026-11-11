/**
 * The parts of the OpenTelemetry API that mcp-handler uses, read from the
 * global registry that `@opentelemetry/api` 1.x writes when an app registers a
 * tracer provider (for example with `registerMcpOTel()` from
 * `mcp-handler/otel`, or `registerOTel()` from `@vercel/otel`).
 *
 * mcp-handler has no runtime dependency on `@opentelemetry/api`: importing it
 * would make every app that uses mcp-handler depend on the API, which turns
 * off Vercel's default tracing for Next.js projects. When no tracer provider
 * is registered, nothing is recorded and nothing is loaded.
 */

const GLOBAL_API_KEY = Symbol.for("opentelemetry.js.api.1");
const TRACER_NAME = "mcp-handler";

/** `SpanKind.INTERNAL` in `@opentelemetry/api`. */
export const SPAN_KIND_INTERNAL = 0;
/** `SpanKind.SERVER` in `@opentelemetry/api`. */
export const SPAN_KIND_SERVER = 1;
/** `SpanKind.CLIENT` in `@opentelemetry/api`. */
export const SPAN_KIND_CLIENT = 2;
/** `SpanStatusCode.ERROR` in `@opentelemetry/api`. */
export const SPAN_STATUS_ERROR = 2;

export type Attributes = Record<string, string | number | boolean>;

export interface Span {
  setStatus(status: { code: number }): unknown;
  end(): void;
}

export interface SpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  isRemote?: boolean;
}

export interface Tracer {
  startSpan(
    name: string,
    options: {
      kind: number;
      startTime: number;
      attributes: Attributes;
      links?: Array<{ context: SpanContext }>;
    },
    context?: unknown,
  ): Span;
}

/** `TraceFlags.SAMPLED` in `@opentelemetry/api`. */
export const TRACE_FLAG_SAMPLED = 1;

/** The context key `@opentelemetry/api` 1.x stores the active span under. */
const SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");

interface OtelContext {
  getValue(key: symbol): unknown;
  setValue(key: symbol, value: unknown): OtelContext;
}

function isOtelContext(value: unknown): value is OtelContext {
  const candidate = value as Partial<OtelContext> | undefined;
  return (
    typeof candidate?.getValue === "function" &&
    typeof candidate.setValue === "function"
  );
}

/** The span context of the span active in `context`, if any. */
export function activeSpanContext(context: unknown): SpanContext | undefined {
  if (!isOtelContext(context)) {
    return undefined;
  }
  const span = context.getValue(SPAN_KEY) as
    | { spanContext?: () => SpanContext }
    | undefined;
  return span?.spanContext?.();
}

/**
 * `context` with a remote span as its active span, as `trace.setSpanContext`
 * does. Returns `undefined` when `context` is not an OpenTelemetry context
 * (no context manager is registered).
 */
export function withRemoteParent(
  context: unknown,
  spanContext: SpanContext,
): unknown {
  if (!isOtelContext(context)) {
    return undefined;
  }
  const remoteSpan = {
    spanContext: () => spanContext,
    isRecording: () => false,
  };
  return context.setValue(SPAN_KEY, remoteSpan);
}

interface TracerProvider {
  getTracer(name: string): Tracer;
}

interface ContextManager {
  active(): unknown;
}

interface GlobalApi {
  trace?: TracerProvider;
  context?: ContextManager;
}

export interface McpTracing {
  tracer: Tracer;
  /** The active OpenTelemetry context, or `undefined` without a context manager. */
  activeContext(): unknown;
}

/** The registered tracer, or `undefined` when the app registered none. */
export function getMcpTracing(): McpTracing | undefined {
  const registry = globalThis as Record<symbol, GlobalApi | undefined>;
  const api = registry[GLOBAL_API_KEY];
  const provider = api?.trace;
  if (!provider) {
    return undefined;
  }

  const contextManager = api.context;
  return {
    tracer: provider.getTracer(TRACER_NAME),
    activeContext: () => contextManager?.active(),
  };
}
