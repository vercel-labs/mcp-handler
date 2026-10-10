/**
 * @experimental Durable storage for the events engine. Values are opaque
 * strings; the engine owns their encoding and every invariant built on top.
 * Implementations only need per-key compare-and-set, expiry, counters and
 * set indexes. `runEventsStoreConformance` checks these semantics.
 */
export interface McpEventsStore {
  /** Read a value and its version token. Expired values read as absent. */
  get(key: string): Promise<{ value: string; version: string } | null>;
  /**
   * Write only when the current version matches `version`; `null` requires
   * the key to be absent. Returns false without writing otherwise. Without
   * `ttlMs` the value never expires.
   */
  put(
    key: string,
    value: string,
    options: { version: string | null; ttlMs?: number },
  ): Promise<boolean>;
  /** Delete, only when `version` matches if given. Returns whether it deleted. */
  delete(key: string, options?: { version?: string }): Promise<boolean>;
  /** Atomically increment a counter that expires `ttlMs` after creation. */
  increment(key: string, ttlMs: number): Promise<number>;
  addToIndex(index: string, member: string): Promise<void>;
  removeFromIndex(index: string, member: string): Promise<void>;
  /**
   * Page through a set index. Members present for the whole scan are
   * returned at least once. A missing `cursor` in the result ends the scan.
   */
  scanIndex(
    index: string,
    cursor: string | undefined,
    count: number,
  ): Promise<{ members: string[]; cursor?: string }>;
}

/**
 * @experimental A single-process store for development and tests. State is
 * lost on restart and is not shared between serverless instances.
 */
export function memoryStore(): McpEventsStore {
  const values = new Map<
    string,
    { value: string; version: number; expiresAt?: number }
  >();
  const indexes = new Map<string, Set<string>>();
  let versions = 0;

  function live(key: string) {
    const entry = values.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      values.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    async get(key) {
      const entry = live(key);
      return entry
        ? { value: entry.value, version: String(entry.version) }
        : null;
    },
    async put(key, value, { version, ttlMs }) {
      const entry = live(key);
      if (version === null ? entry : String(entry?.version) !== version)
        return false;
      values.set(key, {
        value,
        version: ++versions,
        ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
      });
      return true;
    },
    async delete(key, options) {
      const entry = live(key);
      if (!entry) return false;
      if (
        options?.version !== undefined &&
        String(entry.version) !== options.version
      )
        return false;
      values.delete(key);
      return true;
    },
    async increment(key, ttlMs) {
      const entry = live(key);
      const count = entry ? Number(entry.value) + 1 : 1;
      values.set(key, {
        value: String(count),
        version: ++versions,
        expiresAt: entry?.expiresAt ?? Date.now() + ttlMs,
      });
      return count;
    },
    async addToIndex(index, member) {
      let members = indexes.get(index);
      if (!members) indexes.set(index, (members = new Set()));
      members.add(member);
    },
    async removeFromIndex(index, member) {
      indexes.get(index)?.delete(member);
    },
    async scanIndex(index, cursor, count) {
      // Ordered by member, so concurrent changes never skip a stable member.
      const sorted = [...(indexes.get(index) ?? [])].sort();
      const start =
        cursor === undefined ? 0 : sorted.findIndex((m) => m > cursor);
      const members = start < 0 ? [] : sorted.slice(start, start + count);
      const last = members.at(-1);
      return last !== undefined && start + count < sorted.length
        ? { members, cursor: last }
        : { members };
    },
  };
}
