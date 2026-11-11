import {
  initializeMcpApiHandler,
  type McpHandlerOptions,
  type McpTelemetryOptions,
  type WebMcpOptions,
} from "./mcp-api-handler";
import type { McpServer } from "@modelcontextprotocol/server";

export type { McpHandlerOptions, McpTelemetryOptions, WebMcpOptions };

/**
 * Creates a MCP handler that can be used to handle MCP requests.
 *
 * The returned handler is a web-standard `(request: Request) => Promise<Response>`
 * function. It serves every request it receives — routing belongs to the host
 * framework, so mount it at the route you want (a Next.js route handler,
 * Hono, Nitro, ...).
 *
 * @param initializeServer - A function that initializes the MCP server. Use this to access the server instance and register tools, prompts, and resources.
 * @param options - The SDK's server options plus handler extras (`serverInfo`, `verboseLogs`, `onEvent`, `maxSubscriptions`, `experimental_webMcp`).
 * @returns A function that can be used to handle MCP requests.
 */
export default function createMcpRouteHandler(
  initializeServer:
    | ((server: McpServer) => Promise<void>)
    | ((server: McpServer) => void),
  options?: McpHandlerOptions,
): (request: Request) => Promise<Response> {
  return initializeMcpApiHandler(initializeServer, options);
}
