import type { McpEventsStore } from "./store";

/**
 * @experimental Check a store against the guarantees the engine relies on.
 * Resolves when the store conforms; rejects with the first violation. Uses
 * real time for expiry (about half a second) and unique keys under `prefix`,
 * so it can run against a shared database.
 */
export async function runEventsStoreConformance(
  store: McpEventsStore,
  { prefix = `conformance:${Date.now()}:${Math.random()}:` } = {},
): Promise<void> {
  const key = (name: string) => prefix + name;
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`Store conformance: ${message}`);
  };
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // Compare-and-set.
  check((await store.get(key("cas"))) === null, "missing keys read as null");
  check(
    await store.put(key("cas"), "one", { version: null }),
    "put with version null creates an absent key",
  );
  check(
    !(await store.put(key("cas"), "two", { version: null })),
    "put with version null fails when the key exists",
  );
  const first = await store.get(key("cas"));
  check(first?.value === "one", "get returns the stored value");
  check(
    !(await store.put(key("cas"), "two", { version: first!.version + "x" })),
    "put with a stale version fails",
  );
  check(
    await store.put(key("cas"), "two", { version: first!.version }),
    "put with the current version succeeds",
  );
  const second = await store.get(key("cas"));
  check(
    second?.value === "two" && second.version !== first!.version,
    "a successful put changes the version",
  );
  check(
    !(await store.put(key("cas"), "three", { version: first!.version })),
    "an old version cannot be reused",
  );
  check(
    (await store.get(key("cas")))?.value === "two",
    "failed puts do not write",
  );
  const json = '{"a":[1,"2"],"b":null}';
  await store.put(key("json"), json, { version: null });
  check(
    (await store.get(key("json")))?.value === json,
    "values are returned as the exact strings stored",
  );

  // Delete.
  check(
    !(await store.delete(key("cas"), { version: first!.version })),
    "delete with a stale version fails",
  );
  check(
    await store.delete(key("cas"), { version: second!.version }),
    "delete with the current version succeeds",
  );
  check((await store.get(key("cas"))) === null, "deleted keys read as null");
  check(!(await store.delete(key("cas"))), "deleting a missing key is false");

  // Expiry and counters.
  await store.put(key("ttl"), "soon", { version: null, ttlMs: 150 });
  await store.put(key("forever"), "kept", { version: null });
  check(
    (await store.increment(key("count"), 150)) === 1,
    "counters start at 1",
  );
  check((await store.increment(key("count"), 150)) === 2, "counters increment");
  check(
    (await store.get(key("ttl")))?.value === "soon",
    "ttl keeps it until expiry",
  );
  await sleep(400);
  check((await store.get(key("ttl"))) === null, "values expire after ttlMs");
  check(
    await store.put(key("ttl"), "again", { version: null }),
    "expired keys count as absent for put",
  );
  check(
    (await store.get(key("forever")))?.value === "kept",
    "no ttl never expires",
  );
  check(
    (await store.increment(key("count"), 150)) === 1,
    "counters reset after their ttl",
  );

  // Set indexes.
  const index = key("index");
  const members = Array.from({ length: 25 }, (_, i) => `m${i}`);
  for (const member of members) await store.addToIndex(index, member);
  await store.addToIndex(index, "m0");
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await store.scanIndex(index, cursor, 10);
    page.members.forEach((member) => seen.add(member));
    cursor = page.cursor;
    // Removing a returned member mid-scan must not hide stable ones.
    if (pages++ === 0) await store.removeFromIndex(index, page.members[0]);
    check(pages < 100, "index scans terminate");
  } while (cursor !== undefined);
  check(
    members.every((member) => seen.has(member)),
    "scans return every member present for the whole scan",
  );
  await store.removeFromIndex(index, "m1");
  const after = new Set<string>();
  cursor = undefined;
  do {
    const page = await store.scanIndex(index, cursor, 100);
    page.members.forEach((member) => after.add(member));
    cursor = page.cursor;
  } while (cursor !== undefined);
  check(!after.has("m1"), "removed members are not returned");
  check(after.size === 23, "indexes hold each member once");
  const empty = await store.scanIndex(key("empty"), undefined, 10);
  check(
    empty.members.length === 0 && empty.cursor === undefined,
    "a missing index scans as empty",
  );

  await Promise.all(
    [key("json"), key("ttl"), key("forever"), key("count")].map((k) =>
      store.delete(k),
    ),
  );
  for (const member of after) await store.removeFromIndex(index, member);
}
