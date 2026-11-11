import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpHandler, type McpHandlerOptions } from "../src/index";
import { withMcpAuth } from "../src/auth/auth-wrapper";
import { nodeToWebHandler } from "./helpers";
import { registerTestTracing } from "./tracing";

function registerServer(server: McpServer) {
  server.registerTool(
    "echo",
    { inputSchema: z.object({ message: z.string() }) },
    async ({ message }) => ({ content: [{ type: "text", text: message }] }),
  );
  server.registerTool("broken", {}, async () => {
    throw new Error("private failure detail");
  });
  server.registerPrompt(
    "review",
    { argsSchema: z.object({ topic: z.string() }) },
    () => ({
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: "Hi" } },
      ],
    }),
  );
}

function handlerWith(options?: McpHandlerOptions) {
  return createMcpHandler(registerServer, options);
}

/** A 2025-era request: one JSON-RPC message, or a batch of them. */
function legacyRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.com/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "user-agent": "Claude-User",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function message(method: string, params: unknown = {}, id = 7) {
  return { jsonrpc: "2.0", id, method, params };
}

/** Sends the request and reads the whole answer, as a client does. */
async function send(
  handler: (req: Request) => Promise<Response>,
  request: Request,
) {
  const response = await handler(request);
  await response.text();
  return response;
}

let exporter: InMemorySpanExporter;
let shutdown: () => Promise<void>;

/** What Vercel counts as MCP messages: `SERVER` spans that set `mcp.method.name`. */
function mcpSpans() {
  return exporter
    .getFinishedSpans()
    .filter(
      (span) =>
        span.kind === SpanKind.SERVER &&
        span.attributes["mcp.method.name"] !== undefined,
    );
}

const caller = {
  "vercel.rpc.route": "mcp",
  "vercel.rpc.client.name": "claude",
  "vercel.rpc.auth.outcome": "anonymous",
  "mcp.protocol.version": "2025-06-18",
};

const invalidParams = {
  "vercel.rpc.outcome": "request_error",
  "error.type": "invalid_request",
  "rpc.response.status_code": "-32602",
};

beforeEach(() => {
  ({ exporter, shutdown } = registerTestTracing());
});

afterEach(async () => {
  await shutdown();
});

describe("MCP message spans", () => {
  it.each([
    [
      "tools/call",
      { name: "echo", arguments: { message: "hi" } },
      "tools/call echo",
      {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "echo",
      },
    ],
    ["tools/list", {}, "tools/list", {}],
    [
      "prompts/get",
      { name: "review", arguments: { topic: "spans" } },
      "prompts/get review",
      { "gen_ai.prompt.name": "review" },
    ],
    // Names the server has not registered come from the client: never recorded.
    [
      "tools/call",
      { name: "private-tool", arguments: {} },
      "tools/call",
      { "gen_ai.operation.name": "execute_tool", ...invalidParams },
    ],
    ["prompts/get", { name: "private-prompt" }, "prompts/get", invalidParams],
    // The SDK answers a throwing tool with an `isError` result.
    [
      "tools/call",
      { name: "broken", arguments: {} },
      "tools/call broken",
      {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "broken",
        "vercel.rpc.outcome": "execution_failure",
        "error.type": "internal_error",
      },
    ],
    [
      "private/method",
      {},
      "other",
      {
        "vercel.rpc.outcome": "request_error",
        "error.type": "not_found",
        "rpc.response.status_code": "-32601",
      },
    ],
  ])("writes one span for %s %o", async (method, params, name, attributes) => {
    await send(handlerWith(), legacyRequest(message(method, params)));

    const spans = mcpSpans();
    expect(spans.map((span) => span.name)).toEqual([name]);
    const [span] = spans;
    expect(span.attributes).toEqual({
      "mcp.method.name": name.split(" ")[0],
      "jsonrpc.request.id": "7",
      ...caller,
      "vercel.rpc.outcome": "success",
      ...attributes,
    });
    const expectedStatus =
      "error.type" in attributes ? SpanStatusCode.ERROR : SpanStatusCode.UNSET;
    expect(span.status.code).toBe(expectedStatus);
    expect(JSON.stringify(span.attributes)).not.toContain("private");
  });

  it("reads the protocol version an initialize request carries", async () => {
    await send(
      handlerWith(),
      legacyRequest(
        message("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        }),
        { "mcp-protocol-version": "" },
      ),
    );

    const [span] = mcpSpans();
    expect(span.name).toBe("initialize");
    expect(span.attributes["mcp.protocol.version"]).toBe("2025-06-18");
  });

  it("counts each message of a batch, and a notification", async () => {
    await send(
      handlerWith(),
      legacyRequest([
        message("tools/list", {}, 1),
        { jsonrpc: "2.0", method: "notifications/initialized" },
        message("tools/call", { name: "echo", arguments: { message: "hi" } }, 2),
      ]),
    );

    expect(
      mcpSpans()
        .map((span) => span.name)
        .sort(),
    ).toEqual(["notifications/initialized", "tools/call echo", "tools/list"]);
    const notification = mcpSpans().find(
      (span) => span.name === "notifications/initialized",
    )!;
    expect(notification.attributes).toEqual({
      "mcp.method.name": "notifications/initialized",
      ...caller,
      "vercel.rpc.outcome": "success",
    });
  });

  it("is a child of the active request span", async () => {
    const request = trace.getTracer("test").startSpan("POST /api/mcp");
    await context.with(trace.setSpan(context.active(), request), () =>
      send(handlerWith(), legacyRequest(message("tools/list"))),
    );
    request.end();

    const [span] = mcpSpans();
    expect(span.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
    // The request span is not an MCP message, so it never names the method.
    const requestSpan = exporter
      .getFinishedSpans()
      .find((finished) => finished.name === "POST /api/mcp")!;
    expect(requestSpan.attributes["mcp.method.name"]).toBeUndefined();
  });

  it("records the route option and an authorized caller", async () => {
    const handler = withMcpAuth(
      handlerWith({ telemetry: { route: "admin" } }),
      (_req, token) =>
        token === "good"
          ? {
              token,
              clientId: "https://chatgpt.com/oauth/codex/abc/client.json",
              scopes: [],
            }
          : undefined,
      { required: true },
    );

    await send(
      handler,
      legacyRequest(message("tools/list"), {
        authorization: "Bearer good",
        "user-agent": "node",
      }),
    );

    const [span] = mcpSpans();
    expect(span.attributes).toMatchObject({
      "vercel.rpc.route": "admin",
      "vercel.rpc.auth.outcome": "authorized",
      "vercel.rpc.client.name": "http-library",
    });
  });

  it("writes no span for a request rejected at auth", async () => {
    const handler = withMcpAuth(handlerWith(), () => undefined, {
      required: true,
    });

    const response = await send(handler, legacyRequest(message("tools/list")));

    expect(response.status).toBe(401);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it("writes no span when telemetry is off", async () => {
    await send(
      handlerWith({ telemetry: false }),
      legacyRequest(message("tools/list")),
    );

    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it("serves requests unchanged when no tracer provider is registered", async () => {
    await shutdown();

    const response = await send(
      handlerWith(),
      legacyRequest(message("tools/call", { name: "echo", arguments: { message: "hi" } })),
    );

    expect(response.status).toBe(200);
    ({ exporter, shutdown } = registerTestTracing());
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});

describe("MCP message spans with the SDK client", () => {
  let server: Server;
  let client: Client;

  beforeEach(async () => {
    server = createServer(nodeToWebHandler(handlerWith()));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    client = new Client({ name: "spans-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/`)),
    );
  });

  afterEach(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("writes one span per message a real client sends", async () => {
    await client.callTool({ name: "echo", arguments: { message: "hi" } });

    const names = mcpSpans().map((span) => span.name);
    expect(names).toContain("tools/call echo");
    expect(names.filter((name) => name === "tools/call echo")).toHaveLength(1);
    const toolSpan = mcpSpans().find((span) => span.name === "tools/call echo")!;
    expect(toolSpan.attributes).toMatchObject({
      "vercel.rpc.outcome": "success",
      "vercel.rpc.route": "mcp",
      "gen_ai.tool.name": "echo",
    });
  });
});
