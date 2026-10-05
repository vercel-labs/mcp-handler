import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { McpServer, ProtocolError } from "@modelcontextprotocol/server";
import {
  createMcpHandler,
  experimental_registerMcpEvents,
  withMcpAuth,
  type ExperimentalMcpEventDefinition,
  type ExperimentalMcpEventsOptions,
  type ExperimentalMcpWebhookSubscription,
} from "../src/index";

const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const otherSecret = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
const input = () => ({
  name: "issue.created",
  arguments: { project: "ABC" },
  delivery: {
    mode: "webhook",
    url: "https://receiver.example/hooks/one",
    secret,
  },
});

function setup(overrides: Partial<ExperimentalMcpEventsOptions> = {}) {
  // A fixture only. Production adapters must durably persist and schedule work.
  const records = new Map<string, ExperimentalMcpWebhookSubscription>();
  const upsert = vi.fn(async (record: ExperimentalMcpWebhookSubscription) => {
    records.set(record.id, record);
    return { cursor: null as string | null, truncated: false };
  });
  const remove = vi.fn(async (key: { id: string }) => records.delete(key.id));
  const verifyEndpoint = vi.fn(async () => ({ verified: true as const }));
  const authorize = vi.fn(
    async (args: Record<string, unknown>) => args.project === "ABC",
  );
  const event: ExperimentalMcpEventDefinition = {
    name: "issue.created",
    description: "New issues",
    inputSchema: z.strictObject({
      project: z.string(),
      filter: z.record(z.string(), z.unknown()).optional(),
    }),
    payloadSchema: z.object({ id: z.string() }),
    authorize,
  };
  const options: ExperimentalMcpEventsOptions = {
    getPrincipal: (auth) => String(auth.extra?.subject ?? ""),
    events: [event],
    subscriptions: { upsert, remove },
    delivery: { verifyEndpoint },
    ...overrides,
  };
  const onEvent = vi.fn();
  const handler = withMcpAuth(
    createMcpHandler(
      (server) => {
        server.registerTool(
          "echo",
          { inputSchema: z.object({ text: z.string() }) },
          async ({ text }) => ({ content: [{ type: "text", text }] }),
        );
        experimental_registerMcpEvents(server, options);
      },
      { onEvent },
    ),
    async (_req, token) =>
      token
        ? {
            token,
            clientId: "shared-oauth-client",
            scopes: [],
            extra: { subject: token },
          }
        : undefined,
  );

  async function rpc(
    method: string,
    params: unknown = {},
    token: string | null = "alice",
    modern = false,
  ) {
    const response = await handler(
      new Request("https://server.example/custom/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": modern ? "2026-07-28" : "2025-11-25",
          ...(modern ? { "mcp-method": method } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...(params as object),
            ...(modern
              ? {
                  _meta: {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientInfo": {
                      name: "events-test",
                      version: "1",
                    },
                    "io.modelcontextprotocol/clientCapabilities": {},
                  },
                }
              : {}),
          },
        }),
      }),
    );
    const text = await response.text();
    const data = response.headers
      .get("content-type")
      ?.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)))
          .find((value) => value.id === 1)
      : JSON.parse(text);
    return data;
  }
  return {
    rpc,
    records,
    options,
    event,
    onEvent,
    upsert,
    remove,
    verifyEndpoint,
    authorize,
  };
}

describe("experimental_registerMcpEvents", () => {
  it.each([false, true])(
    "serves an authenticated catalog on the existing route (modern=%s)",
    async (modern) => {
      const app = setup();
      const response = await app.rpc("events/list", {}, "alice", modern);
      expect(response.error).toBeUndefined();
      expect(response.result.events).toEqual([
        expect.objectContaining({
          name: "issue.created",
          delivery: ["webhook"],
          inputSchema: expect.objectContaining({
            type: "object",
            required: ["project"],
          }),
          payloadSchema: expect.objectContaining({ type: "object" }),
        }),
      ]);
      const tools = await app.rpc("tools/list", {}, "alice", modern);
      expect(
        tools.result.tools.map((tool: { name: string }) => tool.name),
      ).toEqual(["echo"]);
    },
  );

  it("advertises the extension in modern discovery", async () => {
    const app = setup();
    const response = await app.rpc("server/discover", {}, "alice", true);
    expect(response.result.capabilities.events).toEqual({});
  });

  it("isolates catalog discovery by verified principal", async () => {
    const app = setup();
    app.options.events = ({ principal }) =>
      principal === "alice" ? [app.event] : [];
    expect(
      (await app.rpc("events/list", {}, "alice")).result.events,
    ).toHaveLength(1);
    expect(
      (await app.rpc("events/list", {}, "bob")).result.events,
    ).toHaveLength(0);
    expect((await app.rpc("events/subscribe", input(), "bob")).error.code).toBe(
      -32011,
    );
    expect(app.upsert).not.toHaveBeenCalled();
  });

  it.each(["events/list", "events/subscribe", "events/unsubscribe"])(
    "requires authentication for %s",
    async (method) => {
      const app = setup();
      expect((await app.rpc(method, input(), null)).error.code).toBe(-32012);
      expect(app.upsert).not.toHaveBeenCalled();
      expect(app.remove).not.toHaveBeenCalled();
    },
  );

  it("requires a nonempty application principal", async () => {
    const app = setup({ getPrincipal: () => "" });
    expect((await app.rpc("events/list")).error.code).toBe(-32012);
  });

  it.each([false, true])(
    "verifies consent before persisting and returns a finite grant (modern=%s)",
    async (modern) => {
      const app = setup();
      const response = await app.rpc(
        "events/subscribe",
        input(),
        "alice",
        modern,
      );
      expect(response.error).toBeUndefined();
      expect(response.result.id).toMatch(/^sub_[a-f0-9]{64}$/);
      expect(Date.parse(response.result.refreshBefore)).toBeGreaterThan(
        Date.now(),
      );
      expect(response.result.cursor).toBeNull();
      expect(app.verifyEndpoint.mock.invocationCallOrder[0]).toBeLessThan(
        app.upsert.mock.invocationCallOrder[0],
      );
      expect(app.upsert.mock.calls[0][0]).toMatchObject({
        principal: "alice",
        secret,
        cursor: null,
      });
    },
  );

  it("refreshes the same key across requests, argument ordering, and secret rotation", async () => {
    const app = setup();
    const first = await app.rpc("events/subscribe", {
      ...input(),
      arguments: { project: "ABC", filter: { a: 1, b: 2 } },
    });
    const second = await app.rpc("events/subscribe", {
      ...input(),
      arguments: { filter: { b: 2, a: 1 }, project: "ABC" },
      delivery: { ...input().delivery, secret: otherSecret },
      cursor: "checkpoint",
      maxAgeMs: 1000,
      ttlMs: 120_000,
    });
    expect(second.result.id).toBe(first.result.id);
    expect(app.records.size).toBe(1);
    expect(app.records.get(first.result.id)).toMatchObject({
      secret: otherSecret,
      cursor: "checkpoint",
      maxAgeMs: 1000,
    });
    expect(
      Date.parse(second.result.refreshBefore) - Date.now(),
    ).toBeLessThanOrEqual(120_000);
  });

  it("separates principals sharing an OAuth client ID and callback destinations", async () => {
    const app = setup();
    const first = await app.rpc("events/subscribe", input(), "alice");
    const second = await app.rpc("events/subscribe", input(), "bob");
    const third = await app.rpc("events/subscribe", {
      ...input(),
      delivery: {
        ...input().delivery,
        url: "https://receiver.example/hooks/two",
      },
    });
    expect(
      new Set([first.result.id, second.result.id, third.result.id]).size,
    ).toBe(3);
    await app.rpc("events/unsubscribe", input(), "alice");
    expect(app.records.has(second.result.id)).toBe(true);
    expect(app.records.has(third.result.id)).toBe(true);
  });

  it.each([false, true])(
    "grants no expiry only when both parties opt in (allowNoExpiry=%s)",
    async (allowNoExpiry) => {
      const app = setup({ ttl: { allowNoExpiry } });
      const indefinite = await app.rpc("events/subscribe", {
        ...input(),
        ttlMs: null,
      });
      expect(indefinite.result.refreshBefore === null).toBe(allowNoExpiry);
      const finite = await app.rpc("events/subscribe", {
        ...input(),
        ttlMs: 120_000,
      });
      expect(finite.result.refreshBefore).not.toBeNull();
      const omitted = await app.rpc("events/subscribe", input());
      expect(omitted.result.refreshBefore).not.toBeNull();
    },
  );

  it("clamps TTLs to configured floor and ceiling", async () => {
    const app = setup({
      ttl: { minMs: 60_000, defaultMs: 120_000, maxMs: 180_000 },
    });
    const small = await app.rpc("events/subscribe", { ...input(), ttlMs: 1 });
    expect(Date.parse(small.result.refreshBefore) - Date.now()).toBeGreaterThan(
      59_000,
    );
    const large = await app.rpc("events/subscribe", {
      ...input(),
      ttlMs: 999_999_999,
    });
    expect(
      Date.parse(large.result.refreshBefore) - Date.now(),
    ).toBeLessThanOrEqual(180_000);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid TTL %s before side effects",
    async (ttlMs) => {
      const app = setup();
      expect(
        (await app.rpc("events/subscribe", { ...input(), ttlMs })).error.code,
      ).toBe(-32602);
      expect(app.verifyEndpoint).not.toHaveBeenCalled();
    },
  );

  it("validates event filters and authorizes their values before verification", async () => {
    const app = setup();
    expect(
      (
        await app.rpc("events/subscribe", {
          ...input(),
          arguments: { project: 123 },
        })
      ).error.code,
    ).toBe(-32602);
    expect(
      (
        await app.rpc("events/subscribe", {
          ...input(),
          arguments: { project: "PRIVATE" },
        })
      ).error.code,
    ).toBe(-32012);
    expect(app.verifyEndpoint).not.toHaveBeenCalled();
    expect(app.upsert).not.toHaveBeenCalled();
  });

  it("rejects argument transformations so identity matches authorized and stored filters", async () => {
    const app = setup();
    app.event.inputSchema = z.object({ project: z.string().toUpperCase() });
    expect(
      (
        await app.rpc("events/subscribe", {
          ...input(),
          arguments: { project: "abc" },
        })
      ).error.code,
    ).toBe(-32602);
    expect(app.authorize).not.toHaveBeenCalled();
  });

  it.each([
    "http://receiver.example/hook",
    "https://user:pass@receiver.example/hook",
    "https://receiver.example/hook#fragment",
    "invalid",
  ])("rejects invalid callback %s", async (url) => {
    const app = setup();
    expect(
      (
        await app.rpc("events/subscribe", {
          ...input(),
          delivery: { ...input().delivery, url },
        })
      ).error.code,
    ).toBe(-32602);
    expect(app.verifyEndpoint).not.toHaveBeenCalled();
  });

  it.each([
    "secret",
    "whsec_invalid!",
    `whsec_${Buffer.alloc(23).toString("base64")}`,
    `whsec_${Buffer.alloc(65).toString("base64")}`,
  ])("rejects invalid signing secret %#", async (invalidSecret) => {
    const app = setup();
    expect(
      (
        await app.rpc("events/subscribe", {
          ...input(),
          delivery: { ...input().delivery, secret: invalidSecret },
        })
      ).error.code,
    ).toBe(-32602);
    expect(app.verifyEndpoint).not.toHaveBeenCalled();
  });

  it("does not persist a subscription whose endpoint did not prove consent", async () => {
    const app = setup({
      delivery: {
        verifyEndpoint: async () => ({
          verified: false,
          reason: "challenge_failed",
        }),
      },
    });
    const response = await app.rpc("events/subscribe", input());
    expect(response.error).toMatchObject({
      code: -32015,
      data: { reason: "challenge_failed" },
    });
    expect(app.upsert).not.toHaveBeenCalled();
  });

  it("returns replay watermarks, gaps and categorized delivery status", async () => {
    const app = setup();
    app.upsert.mockResolvedValue({
      cursor: "safe-watermark",
      truncated: true,
      deliveryStatus: { active: true, lastError: "timeout" },
    } as never);
    const response = await app.rpc("events/subscribe", {
      ...input(),
      cursor: "old",
    });
    expect(response.result).toMatchObject({
      cursor: "safe-watermark",
      truncated: true,
      deliveryStatus: { lastError: "timeout" },
    });
  });

  it("allows cleanup after a catalog/schema change without re-verifying the callback", async () => {
    const app = setup();
    await app.rpc("events/subscribe", input());
    app.options.events = [];
    expect(
      (await app.rpc("events/unsubscribe", input())).error,
    ).toBeUndefined();
    expect(app.records.size).toBe(0);
    expect(app.verifyEndpoint).toHaveBeenCalledTimes(1);
    expect((await app.rpc("events/unsubscribe", input())).error).toMatchObject({
      code: -32011,
      data: { kind: "subscription" },
    });
  });

  it("does not expose backend errors, endpoint responses or secrets", async () => {
    const app = setup();
    app.upsert.mockRejectedValueOnce(new Error(`private body ${secret}`));
    const first = await app.rpc("events/subscribe", input());
    expect(first.error.code).toBe(-32603);
    expect(JSON.stringify(first)).not.toContain(secret);
    app.upsert.mockRejectedValueOnce(
      new ProtocolError(-32013, `private ${secret}`, { limit: secret }),
    );
    const second = await app.rpc("events/subscribe", input());
    expect(second.error.code).toBe(-32013);
    expect(JSON.stringify(second)).not.toContain(secret);
    app.upsert.mockResolvedValueOnce({
      cursor: null,
      truncated: false,
      secret,
    } as never);
    expect((await app.rpc("events/subscribe", input())).error.code).toBe(
      -32603,
    );
  });

  it("redacts telemetry without changing the secret passed to the backend", async () => {
    const app = setup();
    await app.rpc("events/subscribe", input());
    expect(JSON.stringify(app.onEvent.mock.calls)).not.toContain(secret);
    expect(
      app.onEvent.mock.calls.find(
        ([event]) => event.type === "REQUEST_RECEIVED",
      )![0].parameters.params.delivery.secret,
    ).toBe("[REDACTED]");
    expect(app.upsert.mock.calls[0][0].secret).toBe(secret);
  });

  it("redacts signing secrets even on servers that have not enabled events", async () => {
    const onEvent = vi.fn();
    const handler = createMcpHandler(() => {}, { onEvent });
    await handler(
      new Request("https://server.example/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "events/subscribe",
          params: input(),
        }),
      }),
    );
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain(secret);
  });

  it("rejects invalid configuration and duplicate registration", () => {
    const { options } = setup();
    const server = new McpServer({ name: "test", version: "1" });
    expect(() =>
      experimental_registerMcpEvents(server, {
        ...options,
        ttl: { minMs: 1000, maxMs: 10 },
      }),
    ).toThrow("TTLs");
    experimental_registerMcpEvents(server, options);
    expect(() => experimental_registerMcpEvents(server, options)).toThrow(
      "already registered",
    );
  });
});
