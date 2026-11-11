import type { McpRequestContext, McpServer } from "@modelcontextprotocol/server";
import { mcpClientName, protocolVersion, VERCEL_RPC_ATTRIBUTES } from "./attributes";
import { traceMcpMessages } from "./message-spans";
import { getMcpTracing, type Attributes } from "./otel-api";

/** Options for the MCP spans `createMcpHandler` writes. */
export interface McpTelemetryOptions {
  /**
   * A bounded label for this endpoint, recorded as `vercel.rpc.route`. Set it
   * to tell apart several MCP endpoints in one project. Never derive it from
   * the URL path: dynamic segments would make every value distinct.
   * @default "mcp"
   */
  route?: string;
}

export const DEFAULT_TELEMETRY_ROUTE = "mcp";

/** What the handler knows about the caller, for every message span. */
function callerAttributes(ctx: McpRequestContext, route: string): Attributes {
  const headers = ctx.requestInfo?.headers;
  const attributes: Attributes = {
    [VERCEL_RPC_ATTRIBUTES.route]: route,
    [VERCEL_RPC_ATTRIBUTES.clientName]: mcpClientName(
      headers?.get("user-agent"),
      ctx.authInfo?.clientId,
    ),
  };

  // `withMcpAuth` passes AuthInfo only for a verified token; requests it
  // rejects never become MCP messages.
  if (ctx.authInfo) {
    attributes[VERCEL_RPC_ATTRIBUTES.authOutcome] = "authorized";
  } else {
    attributes[VERCEL_RPC_ATTRIBUTES.authOutcome] = "anonymous";
  }

  const version = protocolVersion(headers?.get("mcp-protocol-version"));
  if (version) {
    attributes["mcp.protocol.version"] = version;
  }
  return attributes;
}

/**
 * Writes one span per MCP message `server` handles, when the app registered
 * an OpenTelemetry tracer provider. Does nothing otherwise.
 */
export function instrumentMcpServer(
  server: McpServer,
  ctx: McpRequestContext,
  route: string,
): void {
  const tracing = getMcpTracing();
  if (!tracing) {
    return;
  }
  traceMcpMessages(server, tracing, callerAttributes(ctx, route));
}
