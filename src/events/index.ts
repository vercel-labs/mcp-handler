// MCP Events (webhook delivery, draft SEP-3415 with ChatGPT compat).
// Experimental: the API follows the draft and may change with it.

export { defineEvent } from "./engine/define";
export type { McpEvent, McpEventOptions } from "./engine/define";
export { createMcpEvents } from "./engine/engine";
export type {
  McpEventEmitOptions,
  McpEvents,
  McpEventsOptions,
} from "./engine/engine";
export { memoryStore } from "./engine/store";
export type { McpEventsStore } from "./engine/store";
export { redisStore } from "./engine/redis";
export type { RedisClient } from "./engine/redis";
export { memoryQueue } from "./engine/queue";
export { vercelQueue, vercelQueueConsumer } from "./engine/vercel-queue";
export { connect } from "./engine/connect";
export type {
  ConnectAuthorizeOptions,
  ConnectAuthorizeSubject,
} from "./engine/connect";
export type {
  McpEventsJob,
  McpEventsJobProcessor,
  McpEventsJobResult,
  McpEventsMemoryQueue,
  McpEventsQueue,
} from "./engine/queue";
export { runEventsStoreConformance } from "./engine/conformance";
export type { ExperimentalMcpEventsDialect as McpEventsDialect } from "./protocol";
export type { WebhookNetworkOptions } from "./webhook";
export type {
  ExperimentalMcpEventAuthorizationContext as McpEventAuthorizationContext,
  ExperimentalMcpEventContext as McpEventContext,
} from "./types";
