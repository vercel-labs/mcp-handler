import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { McpServer, ProtocolError } from "@modelcontextprotocol/server";
import {
  createMcpHandler,
  experimental_registerMcpEvents,
  experimental_validateMcpEventDelivery,
  withMcpAuth,
  type ExperimentalMcpEventDefinition,
  type ExperimentalMcpEventsOptions,
  type ExperimentalMcpEventContext,
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
  const operations = new Map<string, string>();
  const prepare = vi.fn(async (key: { id: string }) => {
    const operation = crypto.randomUUID();
    operations.set(key.id, operation);
    return operation;
  });
  const upsert = vi.fn(
    async (
      record: ExperimentalMcpWebhookSubscription,
      _context: ExperimentalMcpEventContext,
      operationId: string,
    ) => {
      if (operations.get(record.id) !== operationId)
        throw new Error("Subscription operation superseded");
      records.set(record.id, record);
      return { cursor: null as string | null, truncated: false };
    },
  );
  const remove = vi.fn(async (key: { id: string }) => {
    const pending = operations.delete(key.id);
    const active = records.delete(key.id);
    return pending || active;
  });
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
    subscriptions: { prepare, upsert, remove },
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
    prepare,
    operations,
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
      expect(app.prepare).not.toHaveBeenCalled();
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
      expect(app.prepare.mock.invocationCallOrder[0]).toBeLessThan(
        app.verifyEndpoint.mock.invocationCallOrder[0],
      );
      expect(app.upsert.mock.calls[0][2]).toBe(
        await app.prepare.mock.results[0].value,
      );
      expect(app.upsert.mock.calls[0][0]).toMatchObject({
        principal: "alice",
        secret,
        cursor: null,
      });
      expect(app.authorize).toHaveBeenCalledWith(input().arguments, {
        principal: "alice",
        signal: expect.any(AbortSignal),
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

  it.each([false, true])(
    "does not activate after unsubscribe during verification (modern=%s)",
    async (modern) => {
      const app = setup();
      let finish!: () => void;
      let started!: () => void;
      const verifying = new Promise<void>((resolve) => {
        started = resolve;
      });
      const consent = new Promise<void>((resolve) => {
        finish = resolve;
      });
      app.verifyEndpoint.mockImplementationOnce(async () => {
        started();
        await consent;
        return { verified: true };
      });
      const pending = app.rpc("events/subscribe", input(), "alice", modern);
      await verifying;
      const stopped = await app.rpc(
        "events/unsubscribe",
        input(),
        "alice",
        modern,
      );
      expect(stopped.error).toBeUndefined();
      finish();
      expect((await pending).error.code).toBe(-32603);
      expect(app.records.size).toBe(0);
      expect(app.operations.size).toBe(0);
    },
  );

  it("does not overwrite a newer refresh when older verification finishes late", async () => {
    const app = setup();
    const initial = await app.rpc("events/subscribe", input());
    let finish!: () => void;
    let started!: () => void;
    const verifying = new Promise<void>((resolve) => {
      started = resolve;
    });
    const consent = new Promise<void>((resolve) => {
      finish = resolve;
    });
    app.verifyEndpoint.mockImplementationOnce(async () => {
      started();
      await consent;
      return { verified: true };
    });
    const older = app.rpc("events/subscribe", { ...input(), ttlMs: 60_000 });
    await verifying;
    const newer = await app.rpc("events/subscribe", {
      ...input(),
      delivery: { ...input().delivery, secret: otherSecret },
      ttlMs: 120_000,
    });
    expect(newer.result.id).toBe(initial.result.id);
    finish();
    expect((await older).error.code).toBe(-32603);
    expect(app.records.get(initial.result.id)).toMatchObject({
      secret: otherSecret,
      refreshBefore: newer.result.refreshBefore,
    });
  });

  it("preserves an active grant when replacement verification fails", async () => {
    const app = setup();
    const initial = await app.rpc("events/subscribe", input());
    const grant = app.records.get(initial.result.id);
    app.verifyEndpoint.mockRejectedValueOnce(new Error("Verification failed"));
    const replacement = await app.rpc("events/subscribe", {
      ...input(),
      delivery: { ...input().delivery, secret: otherSecret },
    });
    expect(replacement.error.code).toBe(-32603);
    expect(app.records.get(initial.result.id)).toEqual(grant);
    expect(app.upsert).toHaveBeenCalledTimes(1);
  });

  it("enforces admission before network verification and redacts failures", async () => {
    const app = setup();
    app.prepare.mockRejectedValueOnce(new ProtocolError(-32013, secret));
    const response = await app.rpc("events/subscribe", input());
    expect(response.error.code).toBe(-32013);
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(app.verifyEndpoint).not.toHaveBeenCalled();
    expect(app.upsert).not.toHaveBeenCalled();
  });

  it.each(["", " ", undefined, 123])(
    "rejects an invalid reservation token %# before verification",
    async (operationId) => {
      const app = setup();
      app.prepare.mockResolvedValueOnce(operationId as never);
      expect((await app.rpc("events/subscribe", input())).error.code).toBe(
        -32603,
      );
      expect(app.verifyEndpoint).not.toHaveBeenCalled();
      expect(app.upsert).not.toHaveBeenCalled();
    },
  );

  it("validates the persisted grant with the same policy after the request ends", async () => {
    const app = setup();
    const response = await app.rpc("events/subscribe", input());
    const subscription = app.records.get(response.result.id);
    const delivery = {
      event: app.event,
      subscription,
      payload: { id: "issue-1" },
    };
    await expect(
      experimental_validateMcpEventDelivery(delivery),
    ).resolves.toBeUndefined();
    app.authorize.mockResolvedValue(false);
    await expect(
      experimental_validateMcpEventDelivery(delivery),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(app.authorize).toHaveBeenLastCalledWith(input().arguments, {
      principal: "alice",
      signal: expect.any(AbortSignal),
    });
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
    expect(app.prepare).not.toHaveBeenCalled();
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
