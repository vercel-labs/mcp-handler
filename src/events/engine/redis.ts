import { randomUUID } from "node:crypto";
import type { McpEventsStore } from "./store";

/**
 * @experimental The Redis capability the store needs, in the shape of the
 * `redis` (node-redis) client's `eval`. Pass a connected client; adapt other
 * clients to this method.
 */
export interface RedisClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

// Every operation is a single-key Lua script: atomic on any Redis 6.2+ and
// safe on clusters, without WATCH.
const GET = `return redis.call('HMGET', KEYS[1], 'v', 'n')`;

const PUT = `
local current = redis.call('HGET', KEYS[1], 'n')
if ARGV[1] == '' then
  if current then return 0 end
elseif current ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'v', ARGV[2], 'n', ARGV[3])
if ARGV[4] ~= '' then redis.call('PEXPIRE', KEYS[1], ARGV[4]) end
return 1`;

// Counters are plain strings; versioned values are hashes.
const DELETE = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'none' then return 0 end
if kind == 'hash' then
  local current = redis.call('HGET', KEYS[1], 'n')
  if ARGV[1] ~= '' and current ~= ARGV[1] then return 0 end
elseif ARGV[1] ~= '' then
  return 0
end
redis.call('DEL', KEYS[1])
return 1`;

const INCREMENT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

const ADD = `return redis.call('SADD', KEYS[1], ARGV[1])`;
const REMOVE = `return redis.call('SREM', KEYS[1], ARGV[1])`;
const SCAN = `return redis.call('SSCAN', KEYS[1], ARGV[1], 'COUNT', ARGV[2])`;

/**
 * @experimental A Redis-backed store. Versions are random, so a deleted and
 * recreated key never accepts an old version. Scans use SSCAN.
 */
export function redisStore({
  client,
  prefix = "mcp-events:",
}: {
  client: RedisClient;
  /** Namespace per logical MCP server when sharing a database. */
  prefix?: string;
}): McpEventsStore {
  const run = (script: string, key: string, ...args: string[]) =>
    client.eval(script, { keys: [prefix + key], arguments: args });
  return {
    async get(key) {
      const [value, version] = (await run(GET, key)) as (string | null)[];
      return version == null ? null : { value: value!, version };
    },
    async put(key, value, { version, ttlMs }) {
      if (ttlMs !== undefined && !(Number.isSafeInteger(ttlMs) && ttlMs > 0))
        throw new RangeError("ttlMs must be a positive integer");
      const reply = await run(
        PUT,
        key,
        version ?? "",
        value,
        randomUUID(),
        ttlMs === undefined ? "" : String(ttlMs),
      );
      return Number(reply) === 1;
    },
    async delete(key, options) {
      return Number(await run(DELETE, key, options?.version ?? "")) === 1;
    },
    async increment(key, ttlMs) {
      return Number(await run(INCREMENT, key, String(ttlMs)));
    },
    async addToIndex(index, member) {
      await run(ADD, index, member);
    },
    async removeFromIndex(index, member) {
      await run(REMOVE, index, member);
    },
    async scanIndex(index, cursor, count) {
      const [next, members] = (await run(
        SCAN,
        index,
        cursor ?? "0",
        String(count),
      )) as [string, string[]];
      return { members, ...(String(next) !== "0" ? { cursor: next } : {}) };
    },
  };
}
