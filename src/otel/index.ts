import { registerOTel, type Configuration } from "@vercel/otel";

type SpanProcessorOrName = NonNullable<Configuration["spanProcessors"]>[number];

/**
 * `@vercel/otel` copies the request's `User-Agent` and `Referer` onto every
 * span it treats as a root: spans with no parent and spans on a trace it
 * hasn't seen yet. Neither is bounded, and the referer is a URL.
 * `vercel.rpc.client.name` carries the client instead.
 */
const REDACTED_ATTRIBUTES = ["http.user_agent", "http.referer"] as const;

/**
 * Removes the raw request headers before any exporter sees a span. Must run
 * inside `@vercel/otel`'s composite processor, ahead of `'auto'`: it sets the
 * request attributes before calling each processor's `onStart`.
 */
class RedactRequestHeadersSpanProcessor {
  onStart(span: { attributes: Record<string, unknown> }): void {
    for (const key of REDACTED_ATTRIBUTES) {
      delete span.attributes[key];
    }
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Registers OpenTelemetry with `@vercel/otel` so the spans `createMcpHandler`
 * writes reach Vercel's MCP observability. Call it from the `register`
 * function of your `instrumentation.ts`:
 *
 * ```ts
 * import { registerMcpOTel } from "mcp-handler/otel";
 *
 * export function register() {
 *   registerMcpOTel();
 * }
 * ```
 *
 * Takes the same configuration as `registerOTel`. It defaults the service name
 * to the Vercel project name, as Vercel's default tracing does, and removes the
 * raw `User-Agent` and `Referer` attributes `@vercel/otel` adds to spans.
 */
export function registerMcpOTel(configuration: Configuration = {}): void {
  // `@vercel/otel` still lets `OTEL_SERVICE_NAME` win over this name.
  const serviceName =
    configuration.serviceName ?? process.env.VERCEL_PROJECT_NAME;

  const spanProcessors: SpanProcessorOrName[] = [
    new RedactRequestHeadersSpanProcessor() as unknown as SpanProcessorOrName,
    ...(configuration.spanProcessors ?? ["auto"]),
  ];

  registerOTel({ ...configuration, serviceName, spanProcessors });
}
