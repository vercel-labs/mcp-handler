import type { McpServer } from "@modelcontextprotocol/server";
import { SpanStatusCode } from "@opentelemetry/api";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mcpClientName } from "../src/telemetry/attributes";
import { traceMcpMessages } from "../src/telemetry/message-spans";
import { getMcpTracing } from "../src/telemetry/otel-api";
import { registerTestTracing } from "./tracing";

let exporter: InMemorySpanExporter;
let shutdown: () => Promise<void>;

beforeEach(() => {
  ({ exporter, shutdown } = registerTestTracing());
});

afterEach(async () => {
  await shutdown();
});

type FakeTransport = {
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  send: (message: unknown) => Promise<void>;
};

/** A traced server on a fake transport, to answer messages by hand. */
async function tracedTransport(
  options: { clientAborted?: boolean; throwOnMessage?: boolean } = {},
) {
  const transport: FakeTransport = { send: async () => {} };
  const server = {
    connect: async (connected: FakeTransport) => {
      connected.onmessage = () => {
        if (options.throwOnMessage) throw new Error("handler failed");
      };
      connected.onclose = () => {};
    },
  } as unknown as McpServer;
  traceMcpMessages(server, {
    tracing: getMcpTracing()!,
    callerAttributes: {},
    clientAborted: () => options.clientAborted === true,
  });
  await server.connect(transport as never);
  return transport;
}

function onlySpan() {
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  return spans[0];
}

describe("message outcomes", () => {
  it.each([
    [
      "an input_required result",
      { result: { resultType: "input_required", inputRequests: {} } },
      { "vercel.rpc.outcome": "input_required" },
    ],
    [
      "a URL elicitation request",
      { error: { code: -32042, message: "Open this URL" } },
      { "vercel.rpc.outcome": "input_required" },
    ],
    [
      "a missing client capability",
      { error: { code: -32021, message: "Missing capability" } },
      { "vercel.rpc.outcome": "request_error", "error.type": "invalid_request" },
    ],
    [
      "an unsupported protocol version",
      { error: { code: -32022, message: "Unsupported" } },
      { "vercel.rpc.outcome": "request_error", "error.type": "invalid_request" },
    ],
    [
      "a missing event subscription",
      { error: { code: -32011, message: "Not found" } },
      { "vercel.rpc.outcome": "request_error", "error.type": "not_found" },
    ],
    [
      "oversized tool arguments",
      {
        result: {
          isError: true,
          content: [{ type: "text", text: "Invalid arguments for tool deploy" }],
        },
      },
      { "vercel.rpc.outcome": "request_error", "error.type": "invalid_request" },
    ],
  ])("records %s as a non-error", async (_name, answer, attributes) => {
    const transport = await tracedTransport();
    transport.onmessage!({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "deploy" },
    });
    await transport.send({ jsonrpc: "2.0", id: 1, ...answer });

    const span = onlySpan();
    expect(span.attributes).toMatchObject(attributes);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it.each([
    [true, "request_error", "cancelled", SpanStatusCode.UNSET],
    [false, "execution_failure", "internal_error", SpanStatusCode.ERROR],
  ])(
    "records a close with the client aborted=%s as %s",
    async (clientAborted, outcome, errorType, status) => {
      const transport = await tracedTransport({ clientAborted });
      transport.onmessage!({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      transport.onclose!();

      const span = onlySpan();
      expect(span.attributes).toMatchObject({
        "vercel.rpc.outcome": outcome,
        "error.type": errorType,
      });
      expect(span.status.code).toBe(status);
    },
  );

  it("still records a notification whose handler throws", async () => {
    const transport = await tracedTransport({ throwOnMessage: true });

    expect(() =>
      transport.onmessage!({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ).toThrow("handler failed");

    expect(onlySpan().name).toBe("notifications/initialized");
  });
});

describe("mcpClientName", () => {
  it.each([
    ["node", "https://claude.ai/oauth/client.json", "claude"],
    ["node", "https://chatgpt.com/oauth/codex/abc/client.json", "codex"],
    [undefined, "https://node.example.com/client.json", "other"],
    [undefined, "https://curl.example.org/client.json", "other"],
    ["Claude-User", undefined, "claude"],
    ["claude-code/2.1.0", "https://example.com/client.json", "claude-code"],
    ["node", undefined, "http-library"],
  ])("names %s with client ID %s as %s", (userAgent, clientId, name) => {
    expect(mcpClientName(userAgent, clientId)).toBe(name);
  });
});
