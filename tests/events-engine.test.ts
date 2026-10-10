import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createClient } from "redis";
import { z } from "zod";
import { createMcpHandler, withMcpAuth } from "../src/index";
import {
  createMcpEvents,
  defineEvent,
  memoryQueue,
  memoryStore,
  type McpEventsOptions,
  type McpEventsStore,
} from "../src/events/index";
import { redisStore } from "../src/events/engine/redis";
import { fakeReceiver } from "./fake-receiver";

vi.mock("node:https", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:https")>()),
  request: vi.fn(),
}));

const secretA = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;
const secretB = `whsec_${Buffer.alloc(32, 2).toString("base64")}`;
const SEP = { extensions: { "io.modelcontextprotocol/events": {} } };

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

// Every engine test runs against memory, and against Redis when REDIS_URL is set.
const redis = process.env.REDIS_URL
  ? createClient({ url: process.env.REDIS_URL })
  : undefined;
beforeAll(async () => {
  await redis?.connect();
});
afterAll(async () => {
  await redis?.quit();
});
const stores: [string, () => McpEventsStore][] = [
  ["memory", () => memoryStore()],
  ...(redis
    ? ([
        [
          "redis",
          () =>
            redisStore({
              client: redis,
              prefix: `test:${crypto.randomUUID()}:`,
            }),
        ],
      ] as [string, () => McpEventsStore][])
    : []),
];
let makeStore = stores[0][1];

function setup(
  overrides: Partial<McpEventsOptions> = {},
  input: z.ZodType = z.strictObject({ project: z.string() }),
  store = makeStore(),
) {
  const queue = memoryQueue({ mode: "manual" });
  const allowed = new Set(["alice:ABC", "alice:XYZ", "bob:ABC"]);
  const policy = { outage: false };
  const issueCreated = defineEvent({
    name: "issue.created",
    input: input as z.ZodObject<{ project: z.ZodString }>,
    payload: z.object({ id: z.string(), project: z.string() }),
    authorize: async ({ project }, { principal }) => {
      if (policy.outage) throw new Error("permissions service unavailable");
      return allowed.has(`${principal}:${project}`);
    },
    partitionBy: {
      arguments: ({ project }) => project,
      payload: ({ project }) => project,
    },
  });
  const events = createMcpEvents({
    events: [issueCreated],
    principal: (auth) => String(auth.extra?.subject),
    store,
    queue,
    ...overrides,
  });
  const handler = withMcpAuth(
    createMcpHandler(() => {}, { events }),
    async (_req, token) =>
      token
        ? { token, clientId: "client", scopes: [], extra: { subject: token } }
        : undefined,
  );

  async function rpc(
    method: string,
    params: object,
    principal: string,
    clientCapabilities: object = {},
  ) {
    const response = await handler(
      new Request("https://server.example/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          authorization: `Bearer ${principal}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
            },
          },
        }),
      }),
    );
    const text = await response.text();
    return response.headers.get("content-type")?.includes("event-stream")
      ? JSON.parse(
          text
            .split("\n")
            .find((l) => l.startsWith("data: "))!
            .slice(6),
        )
      : JSON.parse(text);
  }

  const subscribe = (
    principal: string,
    project: string,
    {
      url = "https://receiver.example/hooks/one",
      secret = secretA,
      sep = false,
      ...extra
    }: {
      url?: string;
      secret?: string;
      sep?: boolean;
      [key: string]: unknown;
    } = {},
  ) =>
    rpc(
      "events/subscribe",
      {
        name: "issue.created",
        arguments: { project },
        delivery: { mode: "webhook", url, secret },
        ...extra,
      },
      principal,
      sep ? SEP : {},
    );
  const unsubscribe = (
    principal: string,
    project: string,
    url = "https://receiver.example/hooks/one",
  ) =>
    rpc(
      "events/unsubscribe",
      { name: "issue.created", arguments: { project }, delivery: { url } },
      principal,
    );
  const emit = (id: string, project: string) =>
    events.emit(issueCreated, { id: `issue-${id}`, project }, { id });

  return {
    events,
    issueCreated,
    queue,
    store,
    allowed,
    policy,
    rpc,
    subscribe,
    unsubscribe,
    emit,
  };
}

describe.each(stores)("createMcpEvents (%s store)", (_, factory) => {
  beforeEach(() => {
    makeStore = factory;
  });

  it("verifies once per principal and URL, then delivers signed events to its partition", async () => {
    const receiver = fakeReceiver();
    const app = setup();
    const aliceAbc = await app.subscribe("alice", "ABC");
    await app.subscribe("alice", "XYZ");
    const bobAbc = await app.subscribe("bob", "ABC", { secret: secretB });
    expect(aliceAbc.result).toMatchObject({ cursor: null, truncated: false });
    // Alice's second subscription reuses her consent for the same URL.
    expect(receiver.verifications()).toHaveLength(2);

    await app.emit("evt_1", "ABC");
    await app.emit("evt_1", "ABC"); // duplicate emits collapse
    await app.queue.drain();

    const delivered = receiver.events();
    expect(
      delivered.map((d) => d.headers["x-mcp-subscription-id"]).sort(),
    ).toEqual([aliceAbc.result.id, bobAbc.result.id].sort());
    for (const delivery of delivered) {
      const secret =
        delivery.headers["x-mcp-subscription-id"] === bobAbc.result.id
          ? secretB
          : secretA;
      expect(receiver.verifies(delivery, secret)).toBe(true);
      expect(delivery.headers["webhook-id"]).toBe("evt_1");
      expect(delivery.json).toEqual({
        eventId: "evt_1",
        name: "issue.created",
        timestamp: expect.any(String),
        data: { id: "issue-evt_1", project: "ABC" },
        cursor: null,
      });
    }
  });

  it("retries with Retry-After until maxDeliveryAttempts and reports deliveryStatus", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const receiver = fakeReceiver((entry) =>
      entry.json.type
        ? undefined
        : { status: 503, headers: { "retry-after": "5" } },
    );
    const app = setup({ maxDeliveryAttempts: 3 });
    await app.subscribe("alice", "ABC");
    await app.emit("evt_1", "ABC");
    for (let i = 0; i < 4; i++) {
      await app.queue.drain();
      vi.setSystemTime(Date.now() + 5_000);
    }
    expect(receiver.events()).toHaveLength(3);
    expect(app.queue.pending()).toEqual([]);
    const refreshed = await app.subscribe("alice", "ABC");
    expect(refreshed.result.deliveryStatus).toEqual({
      active: true,
      lastError: "http_5xx",
      failedSince: expect.any(String),
    });
  });

  it("does not retry 410 or 413", async () => {
    for (const status of [410, 413]) {
      const receiver = fakeReceiver((entry) =>
        entry.json.type ? undefined : { status },
      );
      const app = setup();
      await app.subscribe("alice", "ABC");
      await app.emit("evt_1", "ABC");
      await app.queue.drain();
      expect(receiver.events()).toHaveLength(1);
      expect(app.queue.pending()).toEqual([]);
    }
  });

  it("dual-signs with a replaced secret during the rotation grace period", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const receiver = fakeReceiver();
    const app = setup();
    await app.subscribe("alice", "ABC", { secret: secretA });
    await app.subscribe("alice", "ABC", { secret: secretB });
    await app.emit("evt_1", "ABC");
    await app.queue.drain();
    // Verify before moving the clock: receivers reject stale timestamps.
    const [during] = receiver.events();
    expect(receiver.verifies(during, secretA)).toBe(true);
    expect(receiver.verifies(during, secretB)).toBe(true);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await app.emit("evt_2", "ABC");
    await app.queue.drain();
    const [, after] = receiver.events();
    expect(receiver.verifies(after, secretA)).toBe(false);
    expect(receiver.verifies(after, secretB)).toBe(true);
  });

  it("stops delivering after unsubscribe and expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const receiver = fakeReceiver();
    const app = setup();
    await app.subscribe("alice", "ABC");
    await app.subscribe("alice", "XYZ", { ttlMs: 60_000 });
    expect((await app.unsubscribe("alice", "ABC")).result).toEqual(
      expect.objectContaining({}),
    );
    expect((await app.unsubscribe("alice", "ABC")).error.code).toBe(-32011);
    vi.setSystemTime(Date.now() + 61_000);
    await app.emit("evt_1", "ABC");
    await app.emit("evt_1", "XYZ");
    await app.queue.drain();
    expect(receiver.events()).toEqual([]);
  });

  it("ends revoked subscriptions, sending terminated only to SEP-3415 clients", async () => {
    const receiver = fakeReceiver();
    const app = setup();
    await app.subscribe("alice", "ABC", {
      url: "https://receiver.example/chatgpt",
    });
    const sep = await app.subscribe("alice", "ABC", {
      url: "https://receiver.example/sep",
      sep: true,
    });
    app.allowed.delete("alice:ABC");
    await app.emit("evt_1", "ABC");
    await app.queue.drain();
    expect(receiver.events()).toEqual([]);
    expect(receiver.controls()).toHaveLength(1);
    const [terminated] = receiver.controls();
    expect(terminated.url).toBe("https://receiver.example/sep");
    expect(terminated.headers["x-mcp-subscription-id"]).toBe(sep.result.id);
    expect(terminated.json).toEqual({
      type: "terminated",
      error: { code: -32024, message: "Forbidden" },
    });
    // Both grants are gone; restoring access does not revive them.
    app.allowed.add("alice:ABC");
    await app.emit("evt_2", "ABC");
    await app.queue.drain();
    expect(receiver.events()).toEqual([]);
  });

  it("retries instead of revoking when the authorization policy throws", async () => {
    const receiver = fakeReceiver();
    const app = setup();
    await app.subscribe("alice", "ABC", { sep: true });
    app.policy.outage = true;
    await app.emit("evt_1", "ABC");
    await app.queue.drain();
    expect(receiver.events()).toEqual([]);
    expect(receiver.controls()).toEqual([]);
    expect(app.queue.pending()).toMatchObject([{ attempt: 2 }]);
    // The subscription survives the outage and delivers once it recovers.
    app.policy.outage = false;
    for (const job of app.queue.pending())
      await app.events.process(job.job, { attempt: job.attempt });
    expect(receiver.events()).toHaveLength(1);
  });

  it("terminates subscriptions whose stored arguments no longer fit the schema", async () => {
    const receiver = fakeReceiver();
    const store = makeStore();
    await setup({}, undefined, store).subscribe("alice", "ABC", { sep: true });
    // A later deployment changes the input schema incompatibly.
    const next = setup(
      {},
      z.strictObject({ project: z.string().length(1) }),
      store,
    );
    await next.emit("evt_1", "ABC");
    await next.queue.drain();
    expect(receiver.controls().map((c) => c.json)).toEqual([
      {
        type: "terminated",
        error: {
          code: -32026,
          message: "Unsupported",
          data: { feature: "inputSchema", reason: "schema_changed" },
        },
      },
    ]);
  });

  it("limits subscriptions per principal and verifications per minute", async () => {
    fakeReceiver();
    const limited = setup({ subscriptionsPerPrincipal: 1 });
    expect((await limited.subscribe("alice", "ABC")).error).toBeUndefined();
    expect((await limited.subscribe("alice", "XYZ")).error.code).toBe(-32013);
    expect(
      (await limited.subscribe("alice", "XYZ", { sep: true })).error.code,
    ).toBe(-32025);

    const throttled = setup({ verificationsPerMinute: 1 });
    expect((await throttled.subscribe("alice", "ABC")).error).toBeUndefined();
    const second = await throttled.subscribe("alice", "ABC", {
      url: "https://receiver.example/hooks/two",
    });
    expect(second.error).toMatchObject({
      code: -32013,
      message: "Resource exhausted",
    });
  });

  it("does not activate a subscription cancelled during verification", async () => {
    let app: ReturnType<typeof setup>;
    fakeReceiver(async (entry) => {
      if (entry.json.type === "verification")
        await app.unsubscribe("alice", "ABC");
    });
    app = setup();
    const response = await app.subscribe("alice", "ABC");
    expect(response.error.code).toBe(-32603);
    await app.emit("evt_1", "ABC");
    await app.queue.drain();
    expect(
      vi.mocked((await import("node:https")).request),
    ).toHaveBeenCalledTimes(1);
  });

  it("reports an unrecoverable requested cursor as truncated", async () => {
    fakeReceiver();
    const app = setup();
    expect(
      (await app.subscribe("alice", "ABC", { cursor: "c1" })).result,
    ).toMatchObject({
      cursor: null,
      truncated: true,
    });
  });

  it("validates emitted events", async () => {
    const app = setup();
    await expect(
      app.events.emit(app.issueCreated, { id: 1 } as never, { id: "evt_1" }),
    ).rejects.toThrow("payload schema");
    await expect(
      app.events.emit(
        app.issueCreated,
        { id: "1", project: "ABC" },
        { id: "bad\nid" },
      ),
    ).rejects.toThrow(TypeError);
    const other = defineEvent({
      name: "issue.created",
      input: z.strictObject({}),
      payload: z.object({}),
      authorize: () => true,
    });
    await expect(app.events.emit(other, {}, { id: "evt_1" })).rejects.toThrow(
      "Unknown event",
    );
    expect(() =>
      createMcpEvents({
        events: [app.issueCreated, app.issueCreated],
        principal: () => "p",
        store: memoryStore(),
        queue: memoryQueue(),
      }),
    ).toThrow("unique");
  });
});
