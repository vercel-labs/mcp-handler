import { context, propagation, trace, TraceFlags } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, expect, it } from "vitest";
import { registerMcpOTel } from "../src/otel";

const requestContextSymbol = Symbol.for("@vercel/request-context");
const globals = globalThis as { [requestContextSymbol]?: unknown };

afterEach(() => {
  delete globals[requestContextSymbol];
  trace.disable();
  propagation.disable();
  context.disable();
});

// The real `@vercel/otel` pipeline, which copies request headers onto every
// span it treats as a root, including a span on a client's trace.
it("drops the request headers @vercel/otel copies onto root spans", () => {
  globals[requestContextSymbol] = {
    get: () => ({
      waitUntil: () => {},
      headers: {
        host: "mcp.example.com",
        "user-agent": "Cursor/1.0.0 (darwin arm64)",
        referer: "https://example.com/private",
        "x-vercel-id": "iad1::abc",
      },
    }),
  };
  const exporter = new InMemorySpanExporter();
  registerMcpOTel({
    serviceName: "test",
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    instrumentations: [],
  });

  const clientContext = trace.setSpanContext(context.active(), {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
  trace
    .getTracer("mcp-handler")
    .startSpan(
      "tools/call echo",
      { attributes: { "gen_ai.tool.name": "echo" } },
      clientContext,
    )
    .end();

  const [span] = exporter.getFinishedSpans();
  expect(span?.attributes).not.toHaveProperty("http.user_agent");
  expect(span?.attributes).not.toHaveProperty("http.referer");
  expect(span?.attributes).toMatchObject({
    "gen_ai.tool.name": "echo",
    "http.host": "mcp.example.com",
    "vercel.request_id": "abc",
  });
});
