/**
 * Bounded values for MCP span attributes, so Vercel's RPC metrics can group by
 * them. Every value comes from a fixed vocabulary or a validated format. Tool
 * arguments, results, error messages, user IDs and raw user agents never
 * become attributes.
 *
 * The keys follow the OpenTelemetry MCP semantic conventions, plus the
 * `vercel.rpc.*` keys Vercel observability shares across RPC-style protocols
 * for what the standard attributes have no key for.
 */

export const VERCEL_RPC_ATTRIBUTES = {
  outcome: "vercel.rpc.outcome",
  clientName: "vercel.rpc.client.name",
  route: "vercel.rpc.route",
  authOutcome: "vercel.rpc.auth.outcome",
} as const;

/** Ordered: the first matching rule names the client. */
const CLIENT_NAME_RULES: Array<[RegExp, string]> = [
  [/claude-code/i, "claude-code"],
  [/^Claude-User\b/i, "claude"],
  [/codex/i, "codex"],
  [/^openai-mcp\b/i, "chatgpt"],
  [/^Cursor\b/i, "cursor"],
  [/Visual Studio Code|\bvscode\b|copilot/i, "vscode"],
  [/windsurf|codeium/i, "windsurf"],
  [/gemini/i, "gemini"],
  [/grok/i, "grok"],
  [/^Muse\b/i, "muse"],
  [/hermes-agent|nousresearch/i, "hermes"],
  [/mcp-inspector|modelcontextprotocol\/inspector/i, "mcp-inspector"],
  [/^v0\b/i, "v0"],
  [
    /^(python-httpx2?|python-requests|aiohttp|undici|node|node-fetch|axios|Go-http-client|curl|okhttp|Java)\b/i,
    "http-library",
  ],
];

const CLIENT_HOST_RULES: Array<[RegExp, string]> = [
  [/(^|\.)claude\.ai$/, "claude"],
  [/(^|\.)(chatgpt|openai)\.com$/, "chatgpt"],
  [/(^|\.)v0\.(app|dev)$/, "v0"],
];

function clientIdUrl(clientId: unknown): URL | undefined {
  const isMetadataDocument =
    typeof clientId === "string" && /^https:\/\//i.test(clientId);
  if (!isMetadataDocument) {
    return undefined;
  }
  try {
    return new URL(clientId);
  } catch {
    return undefined;
  }
}

/**
 * Maps the user agent and OAuth client ID to a fixed client vocabulary.
 * Unknown clients are `other`; the raw user agent is never returned.
 */
export function mcpClientName(
  userAgent: string | null | undefined,
  clientId?: unknown,
): string {
  const url = clientIdUrl(clientId);
  const candidates: Array<string | undefined> = [];
  if (typeof userAgent === "string") {
    candidates.push(userAgent.slice(0, 256));
  }
  if (url) {
    // The metadata path tells apart clients sharing a host (Codex on chatgpt.com).
    candidates.push(`${url.hostname}${url.pathname}`);
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const [pattern, name] of CLIENT_NAME_RULES) {
      if (pattern.test(candidate)) return name;
    }
  }
  if (url) {
    for (const [pattern, name] of CLIENT_HOST_RULES) {
      if (pattern.test(url.hostname)) return name;
    }
  }
  return "other";
}

const MCP_METHODS = new Set([
  "initialize",
  "server/discover",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/roots/list_changed",
  "events/list",
  "events/subscribe",
  "events/unsubscribe",
]);

/** Known MCP methods, `other` for anything else. */
export function knownMcpMethod(method: unknown): string {
  const isKnown = typeof method === "string" && MCP_METHODS.has(method);
  if (isKnown) {
    return method;
  }
  return "other";
}

/** A dated MCP protocol revision such as `2025-06-18`. */
export function protocolVersion(value: unknown): string | undefined {
  const isDatedRevision =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (isDatedRevision) {
    return value;
  }
  return undefined;
}

export type RequestErrorType =
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "rate_limited";

export type MessageFailure =
  | { outcome: "request_error"; errorType: RequestErrorType | "cancelled" }
  | { outcome: "execution_failure"; errorType: "internal_error" };

/**
 * JSON-RPC error codes that mean the caller sent a request the server could
 * not serve: the ones the MCP semantic conventions list, and the ones
 * mcp-handler answers `events/*` requests with.
 */
const REQUEST_ERRORS = new Map<number, RequestErrorType>([
  [-32700, "invalid_request"], // Parse error
  [-32600, "invalid_request"], // Invalid request
  [-32601, "not_found"], // Method not found
  [-32602, "invalid_request"], // Invalid params, and unknown tools and prompts
  [-32002, "not_found"], // Resource not found
  [-32011, "not_found"], // Event or subscription not found
  [-32012, "forbidden"],
  [-32013, "rate_limited"], // Subscription limit
  [-32014, "invalid_request"], // Unsupported event option
  [-32015, "invalid_request"], // Callback verification failed
]);

/** Outcome and `error.type` of a message answered with a JSON-RPC error. */
export function rpcErrorOutcome(code: unknown): MessageFailure {
  let errorType: RequestErrorType | undefined;
  if (typeof code === "number") {
    errorType = REQUEST_ERRORS.get(code);
  }
  if (errorType) {
    return { outcome: "request_error", errorType };
  }
  return { outcome: "execution_failure", errorType: "internal_error" };
}
