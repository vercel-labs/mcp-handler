import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStore } from "../src/events/engine/store";
import { memoryQueue, type McpEventsJob } from "../src/events/engine/queue";
import { runEventsStoreConformance } from "../src/events/engine/conformance";
import { redisStore } from "../src/events/engine/redis";
import { createClient } from "redis";

const job = (eventId: string): McpEventsJob => ({
  type: "deliver",
  subscription: "sub_1",
  event: "issue.created",
  eventId,
  occurredAt: new Date(0).toISOString(),
  data: {},
});

afterEach(() => {
  vi.useRealTimers();
});

describe("memoryStore", () => {
  it("passes the store conformance checks", async () => {
    await expect(runEventsStoreConformance(memoryStore())).resolves.toBe(
      undefined,
    );
  });

  it("reports conformance violations", async () => {
    const store = memoryStore();
    const broken = { ...store, put: async () => true };
    await expect(runEventsStoreConformance(broken)).rejects.toThrow(
      "put with version null fails when the key exists",
    );
  });
});

describe.skipIf(!process.env.REDIS_URL)("redisStore", () => {
  it("passes the store conformance checks against a real Redis", async () => {
    const client = createClient({ url: process.env.REDIS_URL });
    await client.connect();
    try {
      const store = redisStore({ client });
      await expect(runEventsStoreConformance(store)).resolves.toBe(undefined);
    } finally {
      await client.quit();
    }
  });
});

describe("memoryQueue", () => {
  it("deduplicates by idempotency key and retries on request", async () => {
    vi.useFakeTimers();
    const queue = memoryQueue({ mode: "manual" });
    const attempts: number[] = [];
    queue.bind(async (_job, { attempt }) => {
      attempts.push(attempt);
      return attempt < 3 ? { retryAfterMs: 1_000 } : {};
    });
    await queue.send(job("a"), { idempotencyKey: "k" });
    await queue.send(job("a"), { idempotencyKey: "k" });
    await queue.drain();
    expect(attempts).toEqual([1]);
    expect(queue.pending()).toMatchObject([{ attempt: 2 }]);
    vi.advanceTimersByTime(1_000);
    await queue.drain();
    vi.advanceTimersByTime(1_000);
    await queue.drain();
    expect(attempts).toEqual([1, 2, 3]);
    expect(queue.pending()).toEqual([]);
  });

  it("holds delayed jobs until they are due", async () => {
    vi.useFakeTimers();
    const queue = memoryQueue({ mode: "manual" });
    const processed: string[] = [];
    queue.bind(async (next) => {
      processed.push((next as { eventId: string }).eventId);
      return {};
    });
    await queue.send(job("later"), { idempotencyKey: "1", delayMs: 5_000 });
    await queue.send(job("now"), { idempotencyKey: "2" });
    await queue.drain();
    expect(processed).toEqual(["now"]);
    vi.advanceTimersByTime(5_000);
    await queue.drain();
    expect(processed).toEqual(["now", "later"]);
  });

  it("processes jobs on timers in auto mode and caps unexpected failures", async () => {
    vi.useFakeTimers();
    const queue = memoryQueue();
    const attempts: number[] = [];
    queue.bind(async (_job, { attempt }) => {
      attempts.push(attempt);
      throw new Error("unexpected");
    });
    await queue.send(job("a"), { idempotencyKey: "a" });
    await vi.runAllTimersAsync();
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(queue.pending()).toEqual([]);
  });
});
