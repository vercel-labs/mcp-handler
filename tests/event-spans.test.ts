import { ProtocolError } from "@modelcontextprotocol/server";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
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

  return async (method: string, params: unknown, signal?: AbortSignal) => {
    const response = await handler(
      new Request("https://server.example/mcp", {
        method: "POST",
        signal,
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
    // The client's callback failing is not a server error.
    expect(spans[1].status.code).toBe(SpanStatusCode.UNSET);
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

  it("puts every span of a subscription on the request's trace, linking the client's", async () => {
    const clientTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const request = trace.getTracer("test").startSpan("POST /mcp");

    await context.with(trace.setSpan(context.active(), request), () =>
      setup()("events/subscribe", {
        ...subscribeParams,
        _meta: { traceparent: `00-${clientTraceId}-00f067aa0ba902b7-01` },
      }),
    );
    request.end();

    const spans = exporter
      .getFinishedSpans()
      .filter((span) => span.name !== "POST /mcp");
    expect(spans.map((span) => span.name).sort()).toEqual([
      "events/subscribe",
      "mcp.event.subscription prepare",
      "mcp.event.subscription subscribe",
      "mcp.event.verify_callback",
    ]);
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(request.spanContext().traceId);
      expect(span.links.map((link) => link.context.traceId)).toEqual([
        clientTraceId,
      ]);
    }
  });

  it("records a step the client cancelled as cancelled", async () => {
    const connection = new AbortController();
    const prepare = vi.fn(
      (_key: unknown, { signal }: { signal: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          connection.abort();
          signal.addEventListener("abort", () => reject(signal.reason));
          if (signal.aborted) reject(signal.reason);
        }),
    );

    await setup({ prepare })(
      "events/subscribe",
      subscribeParams,
      connection.signal,
    ).catch(() => undefined);
    await vi.waitFor(() => expect(eventSpans()).toHaveLength(1));

    const [span] = eventSpans();
    expect(span.name).toBe("mcp.event.subscription prepare");
    expect(span.attributes["error.type"]).toBe("cancelled");
  });

  it("records an invalid stored state as a failed subscribe step", async () => {
    const upsert = vi.fn(async () => ({ cursor: 42 }) as never);

    await setup({ upsert })("events/subscribe", subscribeParams);

    const subscribe = eventSpans().find(
      (span) => span.name === "mcp.event.subscription subscribe",
    )!;
    expect(subscribe.attributes["error.type"]).toBe("internal_error");
    expect(subscribe.attributes).not.toHaveProperty(
      "vercel.mcp.subscription.outcome",
    );
    expect(subscribe.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("keeps a store error thrown after the client left", async () => {
    const connection = new AbortController();
    const prepare = vi.fn(async () => {
      connection.abort();
      throw new Error("store unavailable");
    });

    await setup({ prepare })(
      "events/subscribe",
      subscribeParams,
      connection.signal,
    ).catch(() => undefined);
    await vi.waitFor(() => expect(eventSpans()).toHaveLength(1));

    expect(eventSpans()[0].attributes["error.type"]).toBe("internal_error");
  });

  it("writes no event spans when telemetry is off", async () => {
    await setup({}, undefined, { telemetry: false })(
      "events/subscribe",
      subscribeParams,
    );

    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});
