import type { McpServer } from "@modelcontextprotocol/server";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMcpHandler,
  experimental_setToolOutcome,
  type ExperimentalToolOutcome,
  type McpHandlerOptions,
} from "../src/index";
import { registerTestTracing } from "./tracing";

let exporter: InMemorySpanExporter;
let shutdown: () => Promise<void>;

beforeEach(() => {
  ({ exporter, shutdown } = registerTestTracing());
});

afterEach(async () => {
  await shutdown();
});

/** A server whose `report` tool reports `outcome`, then fails or succeeds. */
function handlerReporting(
  outcome: ExperimentalToolOutcome,
  options: { fails?: boolean; handler?: McpHandlerOptions } = {},
) {
  const fails = options.fails ?? true;
  return createMcpHandler((server: McpServer) => {
    server.registerTool("report", {}, async (ctx) => {
      experimental_setToolOutcome(ctx, outcome);
      return {
        isError: fails,
        content: [{ type: "text" as const, text: "done" }],
      };
    });
  }, options.handler);
}

async function callReport(handler: (req: Request) => Promise<Response>) {
  const response = await handler(
    new Request("https://example.com/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "report", arguments: {} },
      }),
    }),
  );
  await response.text();
  return response;
}

function toolSpan() {
  const spans = exporter
    .getFinishedSpans()
    .filter((span) => span.kind === SpanKind.SERVER);
  expect(spans).toHaveLength(1);
  return spans[0];
}

describe("experimental_setToolOutcome", () => {
  it.each([
    [{ outcome: "api_error", errorType: "forbidden" }, "api_error", "forbidden"],
    [{ outcome: "tool_error", errorType: "timeout" }, "tool_error", "timeout"],
    [{ outcome: "tool_error" }, "tool_error", "tool_error"],
    [{ outcome: "api_error" }, "api_error", "api_error"],
  ] as const)(
    "records %o on a failed call",
    async (reported, outcome, errorType) => {
      await callReport(handlerReporting(reported));

      const span = toolSpan();
      expect(span.name).toBe("tools/call report");
      expect(span.attributes).toMatchObject({
        "vercel.rpc.outcome": outcome,
        "error.type": errorType,
      });
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    },
  );

  it("records a reported request_error without marking a server error", async () => {
    await callReport(
      handlerReporting({ outcome: "request_error", errorType: "not_found" }),
    );

    const span = toolSpan();
    expect(span.attributes).toMatchObject({
      "vercel.rpc.outcome": "request_error",
      "error.type": "not_found",
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("never marks a successful call as failed", async () => {
    await callReport(
      handlerReporting({ outcome: "api_error", errorType: "forbidden" }, {
        fails: false,
      }),
    );

    const span = toolSpan();
    expect(span.attributes["vercel.rpc.outcome"]).toBe("success");
    expect(span.attributes).not.toHaveProperty("error.type");
  });

  it("falls back to the default for an error type outside the fixed format", async () => {
    await callReport(
      handlerReporting({
        outcome: "api_error",
        errorType: "Request failed: https://api.example.com/private",
      }),
    );

    expect(toolSpan().attributes["error.type"]).toBe("api_error");
  });

  it("ignores an outcome it doesn't know", async () => {
    await callReport(
      handlerReporting({ outcome: "toString" } as unknown as ExperimentalToolOutcome),
    );

    expect(toolSpan().attributes).toMatchObject({
      "vercel.rpc.outcome": "execution_failure",
      "error.type": "internal_error",
    });
  });

  it("does nothing when telemetry is off", async () => {
    const response = await callReport(
      handlerReporting(
        { outcome: "api_error", errorType: "forbidden" },
        { handler: { telemetry: false } },
      ),
    );

    expect(response.status).toBe(200);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it("does nothing without a tracer provider", async () => {
    await shutdown();

    const response = await callReport(
      handlerReporting({ outcome: "api_error", errorType: "forbidden" }),
    );

    expect(response.status).toBe(200);
    ({ exporter, shutdown } = registerTestTracing());
  });
});

it("records the reported outcome on a 2026-07-28 request", async () => {
  const response = await handlerReporting({
    outcome: "tool_error",
    errorType: "timeout",
  })(
    new Request("https://example.com/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "report",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "report",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );
  await response.text();

  const span = toolSpan();
  expect(span.attributes).toMatchObject({
    "mcp.protocol.version": "2026-07-28",
    "vercel.rpc.outcome": "tool_error",
    "error.type": "timeout",
  });
});
