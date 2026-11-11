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

export interface Tracer {
  startSpan(
    name: string,
    options: { kind: number; startTime: number; attributes: Attributes },
    context?: unknown,
  ): Span;
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
