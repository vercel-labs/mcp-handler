/** @experimental A unit of engine work. Treat as opaque JSON. */
export type McpEventsJob =
  | {
      type: "fanout";
      event: string;
      partition: string;
      eventId: string;
      occurredAt: string;
      data: unknown;
      cursor?: string;
    }
  | {
      type: "deliver";
      subscription: string;
      event: string;
      eventId: string;
      occurredAt: string;
      data: unknown;
    };

/** @experimental What a queue does after processing: acknowledge or retry. */
export type McpEventsJobResult = { retryAfterMs?: number };

/** @experimental Runs one delivery of a job; `attempt` starts at 1. */
export type McpEventsJobProcessor = (
  job: McpEventsJob,
  delivery: { attempt: number },
) => Promise<McpEventsJobResult>;

/**
 * @experimental A durable, at-least-once queue. Sends with the same
 * `idempotencyKey` within the queue's retention window must be delivered once.
 * Queues that call the processor in-process implement `bind`; others route
 * jobs to the engine's `process` from their consumer.
 */
export interface McpEventsQueue {
  send(
    job: McpEventsJob,
    options: { idempotencyKey: string; delayMs?: number },
  ): Promise<void>;
  bind?(processor: McpEventsJobProcessor): void;
}

/** @experimental The in-process queue returned by `memoryQueue`. */
export interface McpEventsMemoryQueue extends McpEventsQueue {
  bind(processor: McpEventsJobProcessor): void;
  /** Process due jobs, including retries that become due, until none remain. */
  drain(): Promise<void>;
  /** Jobs waiting to run, with their next attempt and due time. */
  pending(): ReadonlyArray<{
    job: McpEventsJob;
    attempt: number;
    dueAt: number;
  }>;
}

const MAX_UNEXPECTED_FAILURES = 5;

/**
 * @experimental A single-process queue for development and tests. `auto`
 * processes jobs on timers; `manual` waits for `drain()`. Nothing survives a
 * restart.
 */
export function memoryQueue({
  mode = "auto",
}: { mode?: "auto" | "manual" } = {}): McpEventsMemoryQueue {
  let processor: McpEventsJobProcessor | undefined;
  const seen = new Set<string>();
  const jobs: { job: McpEventsJob; attempt: number; dueAt: number }[] = [];

  async function run(entry: (typeof jobs)[number]) {
    if (!processor) throw new Error("memoryQueue is not bound to an engine");
    let retryAfterMs: number | undefined;
    try {
      ({ retryAfterMs } = await processor(entry.job, {
        attempt: entry.attempt,
      }));
    } catch {
      // The engine reports expected retries as results; cap unexpected ones.
      if (entry.attempt < MAX_UNEXPECTED_FAILURES)
        retryAfterMs = 1_000 * 2 ** entry.attempt;
    }
    if (retryAfterMs !== undefined)
      schedule({
        job: entry.job,
        attempt: entry.attempt + 1,
        dueAt: Date.now() + retryAfterMs,
      });
  }

  function schedule(entry: (typeof jobs)[number]) {
    jobs.push(entry);
    if (mode !== "auto") return;
    const timer = setTimeout(() => {
      const index = jobs.indexOf(entry);
      if (index < 0) return; // drain() already took it
      jobs.splice(index, 1);
      void run(entry).catch(() => {});
    }, Math.max(0, entry.dueAt - Date.now()));
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    async send(job, { idempotencyKey, delayMs = 0 }) {
      if (seen.has(idempotencyKey)) return;
      seen.add(idempotencyKey);
      schedule({ job, attempt: 1, dueAt: Date.now() + delayMs });
    },
    bind(next) {
      processor = next;
    },
    async drain() {
      for (;;) {
        const index = jobs.findIndex((entry) => entry.dueAt <= Date.now());
        if (index < 0) return;
        const [entry] = jobs.splice(index, 1);
        await run(entry);
      }
    },
    pending() {
      return [...jobs];
    },
  };
}
