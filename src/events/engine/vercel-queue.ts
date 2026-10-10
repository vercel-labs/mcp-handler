import type { McpEvents } from "./engine";
import type { McpEventsJob, McpEventsQueue } from "./queue";

type QueueMetadata = { deliveryCount: number };
type RetryDirective = { afterSeconds: number } | { acknowledge: true };

const MAX_UNEXPECTED_FAILURES = 5;

/**
 * @experimental Publish engine jobs to a Vercel Queues topic. Pass `send`
 * from `@vercel/queue`; consume the topic with `vercelQueueConsumer`.
 */
export function vercelQueue({
  topic,
  send,
}: {
  /** Letters, digits, `-` and `_` only. */
  topic: string;
  send: (
    topic: string,
    payload: McpEventsJob,
    options: { idempotencyKey: string; delaySeconds?: number },
  ) => Promise<unknown>;
}): McpEventsQueue {
  if (!/^[A-Za-z0-9_-]+$/.test(topic))
    throw new TypeError("Vercel Queues topics allow letters, digits, - and _");
  return {
    async send(job, { idempotencyKey, delayMs }) {
      await send(topic, job, {
        idempotencyKey,
        ...(delayMs ? { delaySeconds: Math.ceil(delayMs / 1_000) } : {}),
      });
    },
  };
}

class RetryLater extends Error {
  constructor(readonly afterMs: number) {
    super("Retry later");
  }
}

/**
 * @experimental A Vercel Queues consumer route for the engine. Pass
 * `handleCallback` from `@vercel/queue` and register the route for the topic
 * with a `queue/v2beta` trigger. Delivery retries use the engine's delays;
 * unexpected failures (such as a store outage) retry with backoff up to five
 * deliveries.
 */
export function vercelQueueConsumer<Route>(
  events: Pick<McpEvents, "process">,
  handleCallback: (
    handler: (message: McpEventsJob, metadata: QueueMetadata) => Promise<void>,
    options: {
      retry: (error: unknown, metadata: QueueMetadata) => RetryDirective;
    },
  ) => Route,
): Route {
  return handleCallback(
    async (job, { deliveryCount }) => {
      const { retryAfterMs } = await events.process(job, {
        attempt: deliveryCount,
      });
      if (retryAfterMs !== undefined) throw new RetryLater(retryAfterMs);
    },
    {
      retry: (error, { deliveryCount }) =>
        error instanceof RetryLater
          ? { afterSeconds: Math.max(1, Math.ceil(error.afterMs / 1_000)) }
          : deliveryCount >= MAX_UNEXPECTED_FAILURES
          ? { acknowledge: true }
          : { afterSeconds: Math.min(300, 5 * 2 ** deliveryCount) },
    },
  );
}
