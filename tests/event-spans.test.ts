import { ProtocolError } from "@modelcontextprotocol/server";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createMcpHandler,
  experimental_registerMcpEvents,
  withMcpAuth,
  type ExperimentalMcpEventsOptions,
  type McpHandlerOptions,
} from "../src/index";
import { registerTestTracing } from "./tracing";

const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const callbackUrl = "https://receiver.example/hooks/private-path";

const subscribeParams = {
  name: "issue.created",
  arguments: { project: "ABC" },
  delivery: { mode: "webhook", url: callbackUrl, secret },
};

function setup(
  overrides: Partial<ExperimentalMcpEventsOptions["subscriptions"]> = {},
  verifyEndpoint: ExperimentalMcpEventsOptions["delivery"]["verifyEndpoint"] = async () => ({
    verified: true,
  }),
  handlerOptions: McpHandlerOptions = {},
) {
  const operations = new Map<string, string>();
  const options: ExperimentalMcpEventsOptions = {
    getPrincipal: (auth) => String(auth.extra?.subject ?? ""),
    events: [
      {
        name: "issue.created",
        inputSchema: z.strictObject({ project: z.string() }),
        payloadSchema: z.object({ id: z.string() }),
        authorize: async () => true,
      },
    ],
    subscriptions: {
      prepare: async (key) => {
        const operation = crypto.randomUUID();
        operations.set(key.id, operation);
        return operation;
      },
      upsert: async () => ({ cursor: null, truncated: false }),
      remove: async () => false,
      ...overrides,
    },
    delivery: { verifyEndpoint },
  };
  const handler = withMcpAuth(
    createMcpHandler(
      (server) => experimental_registerMcpEvents(server, options),
      handlerOptions,
    ),
    async (_req, token) =>
      token
        ? { token, clientId: "client", scopes: [], extra: { subject: token } }
        : undefined,
  );

  return async (method: string, params: unknown) => {
    const response = await handler(
      new Request("https://server.example/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
          "user-agent": "Cursor/1.0.0",
          authorization: "Bearer alice",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    await response.text();
  };
}

let exporter: InMemorySpanExporter;
let shutdown: () => Promise<void>;

beforeEach(() => {
  ({ exporter, shutdown } = registerTestTracing());
});

afterEach(async () => {
  await shutdown();
});

function eventSpans() {
  return exporter
    .getFinishedSpans()
    .filter((span) => span.name.startsWith("mcp.event."));
}

const caller = {
  "vercel.rpc.route": "mcp",
  "vercel.rpc.client.name": "cursor",
};

describe("MCP Events spans", () => {
  it("records each step of a subscription", async () => {
    await setup()("events/subscribe", subscribeParams);

    const spans = eventSpans();
    expect(spans.map((span) => span.name)).toEqual([
      "mcp.event.subscription prepare",
      "mcp.event.verify_callback",
      "mcp.event.subscription subscribe",
    ]);
    const [prepare, verify, subscribe] = spans;
    expect(prepare.kind).toBe(SpanKind.INTERNAL);
    expect(prepare.attributes).toEqual({
      ...caller,
      "vercel.mcp.event.type": "issue.created",
      "vercel.mcp.subscription.action": "prepare",
      "vercel.mcp.subscription.outcome": "prepared",
    });
    expect(verify.kind).toBe(SpanKind.CLIENT);
    expect(verify.attributes).toEqual({
      ...caller,
      "vercel.mcp.event.type": "issue.created",
      "vercel.mcp.event.outcome": "verified",
    });
    expect(subscribe.attributes).toMatchObject({
      "vercel.mcp.subscription.action": "subscribe",
      "vercel.mcp.subscription.outcome": "subscribed",
    });

    // Event spans are not MCP messages: only the request itself is counted.
    const messages = exporter
      .getFinishedSpans()
      .filter((span) => span.attributes["mcp.method.name"] !== undefined);
    expect(messages.map((span) => span.name)).toEqual(["events/subscribe"]);
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toMatch(
      /private-path|whsec_|sub_/,
    );
  });

  it("records a failed callback verification with its reason", async () => {
    await setup({}, async () => ({ verified: false, reason: "timeout" }))(
      "events/subscribe",
      subscribeParams,
    );

    const spans = eventSpans();
    expect(spans.map((span) => span.name)).toEqual([
      "mcp.event.subscription prepare",
      "mcp.event.verify_callback",
    ]);
    expect(spans[1].attributes).toMatchObject({
      "vercel.mcp.event.outcome": "failed",
      "error.type": "timeout",
    });
    expect(spans[1].status.code).toBe(SpanStatusCode.ERROR);
  });

  it("records a store failure as a short error type", async () => {
    const prepare = vi.fn(async () => {
      throw new ProtocolError(-32013, "Subscription limit for team_secret");
    });

    await setup({ prepare })("events/subscribe", subscribeParams);

    const [span] = eventSpans();
    expect(span.name).toBe("mcp.event.subscription prepare");
    expect(span.attributes).toMatchObject({ "error.type": "rate_limited" });
    expect(span.attributes).not.toHaveProperty("vercel.mcp.subscription.outcome");
    expect(JSON.stringify(span.attributes)).not.toContain("team_secret");
  });

  it("records an unsubscribe without the unchecked event name", async () => {
    await setup()("events/unsubscribe", {
      name: "issue.created",
      arguments: { project: "ABC" },
      delivery: { url: callbackUrl },
    });

    const [span] = eventSpans();
    expect(span.name).toBe("mcp.event.subscription unsubscribe");
    expect(span.attributes).toEqual({
      ...caller,
      "vercel.mcp.subscription.action": "unsubscribe",
      "vercel.mcp.subscription.outcome": "not_found",
      "error.type": "not_found",
    });
  });

  it("writes no event spans when telemetry is off", async () => {
    await setup({}, undefined, { telemetry: false })(
      "events/subscribe",
      subscribeParams,
    );

    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});
