import type { McpRequestContext, McpServer } from "@modelcontextprotocol/server";
import { mcpClientName, protocolVersion, VERCEL_RPC_ATTRIBUTES } from "./attributes";
import type { EventTelemetry } from "./event-spans";
import { traceMcpMessages, type ToolFailureReporter } from "./message-spans";
import { getMcpTracing, type Attributes } from "./otel-api";

/** Instrumented servers, so MCP Events can write its spans with the same caller. */
const instrumentedServers = new WeakMap<McpServer, EventTelemetry>();

/**
 * Failure reporters by HTTP request. A tool handler's `ctx.http.req` is the
 * same `Request` the SDK hands the server factory, in both protocol eras.
 */
const failureReporters = new WeakMap<Request, ToolFailureReporter>();

/** The failure reporter for the request a tool call came in on, if traced. */
export function toolFailureReporterFor(
  request: Request | undefined,
): ToolFailureReporter | undefined {
  if (!request) {
    return undefined;
  }
  return failureReporters.get(request);
}

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
  try {
    const tracing = getMcpTracing();
    if (!tracing) {
      return;
    }
    const caller = callerAttributes(ctx, route);
    const reportFailure = traceMcpMessages(server, {
      tracing,
      callerAttributes: caller,
      clientAborted: () => ctx.requestInfo?.signal?.aborted === true,
    });
    if (ctx.requestInfo) {
      failureReporters.set(ctx.requestInfo, reportFailure);
    }
    instrumentedServers.set(server, {
      tracing,
      attributes: {
        [VERCEL_RPC_ATTRIBUTES.route]: caller[VERCEL_RPC_ATTRIBUTES.route],
        [VERCEL_RPC_ATTRIBUTES.clientName]:
          caller[VERCEL_RPC_ATTRIBUTES.clientName],
      },
    });
  } catch {
    // A broken tracer provider must never break the server.
  }
}

/**
 * The event span context for a server `createMcpHandler` instrumented, or
 * `undefined` when telemetry is off or no tracer provider is registered.
 */
export function eventTelemetryFor(server: McpServer): EventTelemetry | undefined {
  return instrumentedServers.get(server);
}
