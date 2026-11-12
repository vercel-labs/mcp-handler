import type { McpRequestContext, McpServer } from "@modelcontextprotocol/server";
import { mcpClientName, protocolVersion, VERCEL_RPC_ATTRIBUTES } from "./attributes";
import type { EventTelemetry } from "./event-spans";
import { traceMcpMessages, type ToolFailureReporter } from "./message-spans";
import { getMcpTracing, type Attributes } from "./otel-api";

interface TelemetryRegistry {
  /** Instrumented servers, so MCP Events can write spans with the same caller. */
  servers: WeakMap<McpServer, EventTelemetry>;
  /**
   * Failure reporters by HTTP request. A tool handler's `ctx.http.req` is the
   * same `Request` the SDK hands the server factory, in both protocol eras.
   */
  failureReporters: WeakMap<Request, ToolFailureReporter>;
}

const REGISTRY_KEY = Symbol.for("mcp-handler.telemetry.v1");

/**
 * The registry, shared on `globalThis` rather than held by this module: the
 * package ships CommonJS and ESM builds, and an app can load
 * `createMcpHandler` through one and `experimental_setToolOutcome` or
 * `experimental_registerMcpEvents` through the other. Module-local maps would
 * then never find each other's entries.
 */
function telemetryRegistry(): TelemetryRegistry {
  const store = globalThis as Record<symbol, TelemetryRegistry | undefined>;
  let registry = store[REGISTRY_KEY];
  if (!registry) {
    registry = { servers: new WeakMap(), failureReporters: new WeakMap() };
    store[REGISTRY_KEY] = registry;
  }
  return registry;
}

/** The failure reporter for the request a tool call came in on, if traced. */
export function toolFailureReporterFor(
  request: Request | undefined,
): ToolFailureReporter | undefined {
  if (!request) {
    return undefined;
  }
  return telemetryRegistry().failureReporters.get(request);
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
      telemetryRegistry().failureReporters.set(ctx.requestInfo, reportFailure);
    }
    telemetryRegistry().servers.set(server, {
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
  return telemetryRegistry().servers.get(server);
}
