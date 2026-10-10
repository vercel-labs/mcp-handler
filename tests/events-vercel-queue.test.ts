import { describe, expect, it, vi } from "vitest";
import {
  vercelQueue,
  vercelQueueConsumer,
  type McpEventsJob,
  type McpEventsJobResult,
} from "../src/events/index";

const job: McpEventsJob = {
  type: "deliver",
  subscription: "sub_1",
  event: "issue.created",
  eventId: "evt_1",
  occurredAt: new Date(0).toISOString(),
  data: {},
};

// Mimics @vercel/queue: a throw is retried per the retry directive.
function fakeHandleCallback(
  handler: (
    message: McpEventsJob,
    metadata: { deliveryCount: number },
  ) => Promise<void>,
  options: {
    retry: (error: unknown, metadata: { deliveryCount: number }) => unknown;
  },
) {
  return async (deliveryCount: number) => {
    try {
      await handler(job, { deliveryCount });
      return "acknowledged";
    } catch (error) {
      return options.retry(error, { deliveryCount });
    }
  };
}

describe("vercelQueue", () => {
  it("publishes jobs with idempotency keys and whole-second delays", async () => {
    const send = vi.fn(async () => ({ messageId: "m" }));
    const queue = vercelQueue({ topic: "mcp-events", send });
    await queue.send(job, { idempotencyKey: "k1" });
    await queue.send(job, { idempotencyKey: "k2", delayMs: 1_500 });
    expect(send.mock.calls).toEqual([
      ["mcp-events", job, { idempotencyKey: "k1" }],
      ["mcp-events", job, { idempotencyKey: "k2", delaySeconds: 2 }],
    ]);
    expect(() => vercelQueue({ topic: "mcp.events", send })).toThrow(TypeError);
  });

  it("maps engine results and failures onto queue retry directives", async () => {
    const results: (McpEventsJobResult | Error)[] = [
      {},
      { retryAfterMs: 30_000 },
      { retryAfterMs: 10 },
      new Error("store unavailable"),
      new Error("store unavailable"),
    ];
    const process = vi.fn(async () => {
      const next = results.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const deliver = vercelQueueConsumer({ process }, fakeHandleCallback);
    expect(await deliver(1)).toBe("acknowledged");
    expect(await deliver(2)).toEqual({ afterSeconds: 30 });
    expect(await deliver(3)).toEqual({ afterSeconds: 1 });
    expect(await deliver(2)).toEqual({ afterSeconds: 20 });
    expect(await deliver(5)).toEqual({ acknowledge: true });
    expect(process.mock.calls.map(([, { attempt }]) => attempt)).toEqual([
      1, 2, 3, 2, 5,
    ]);
  });
});
