import {
  createMcpHandler as createSdkMcpHandler,
  McpServer,
  type CreateMcpHandlerOptions as SdkMcpHandlerOptions,
  type ServerOptions as McpServerOptions,
} from "@modelcontextprotocol/server";
import type {
  McpEvent,
  McpRequestEvent,
  McpErrorEvent,
} from "../lib/log-helper";
import { createEvent } from "../lib/log-helper";
import {
  createWebMcpScriptHandler,
  type WebMcpScriptHandlerOptions,
} from "../webmcp/script-handler";

export type WebMcpOptions = Omit<WebMcpScriptHandlerOptions, "endpoint">;

/**
 * Options for the MCP handler: the SDK's `ServerOptions` (capabilities,
 * instructions, ...) plus handler-level extras.
 */
export type McpHandlerOptions = McpServerOptions & {
  /**
   * Maximum number of concurrent `subscriptions/listen` streams.
   * Set to `0` to reject subscriptions without opening an SSE stream.
   * @default 1024
   */
  maxSubscriptions?: SdkMcpHandlerOptions["maxSubscriptions"];
  /**
   * Name and version reported to clients during initialization.
   */
  serverInfo?: {
    name: string;
    version: string;
  };
  /**
   * If true, enables console logging.
   * @default false
   */
  verboseLogs?: boolean;
  /**
   * Callback function that receives MCP events.
   * This can be used to track analytics, debug issues, or implement custom behaviors.
   */
  onEvent?: (event: McpEvent) => void;
  /**
   * Publishes an allowlisted subset of this server's tools to in-page agents
   * through WebMCP. Load the generated bridge from the MCP route with the
   * `?webmcp-script` query parameter.
   *
   * @experimental WebMCP is an early-stage browser API.
   */
  experimental_webMcp?: WebMcpOptions;
};

export function initializeMcpApiHandler(
  initializeServer:
    | ((server: McpServer) => Promise<void>)
    | ((server: McpServer) => void),
  options: McpHandlerOptions = {},
): (req: Request) => Promise<Response> {
  const {
    serverInfo = {
      name: "mcp-typescript server on vercel",
      version: "0.1.0",
    },
    verboseLogs = false,
    onEvent,
    maxSubscriptions,
    experimental_webMcp,
    ...mcpServerOptions
  } = options;

  // Validate WebMCP configuration when the handler is created rather than on
  // the first request. The real endpoint is inferred from the script request.
  if (experimental_webMcp) {
    createWebMcpScriptHandler({
      ...experimental_webMcp,
      endpoint: "/",
    });
  }

  const emitError = (error: Error) => {
    if (verboseLogs) {
      console.error("MCP handler error:", error);
    }
    onEvent?.(
      createEvent<McpErrorEvent>({
        type: "ERROR",
        error,
        source: "request",
        severity: "error",
      }),
    );
  };

  // The SDK handler serves the 2026-07-28 protocol (stateless, per-request
  // envelope, server/discover) and falls back to stateless serving for
  // 2025-era Streamable HTTP clients. A fresh McpServer is constructed per
  // request via the factory.
  const sdkHandler = createSdkMcpHandler(
    async () => {
      const server = new McpServer(serverInfo, mcpServerOptions);
      await initializeServer(server);
      return server;
    },
    {
      legacy: "stateless",
      onerror: emitError,
      maxSubscriptions,
    },
  );

  return async function mcpApiHandler(req: Request): Promise<Response> {
    if (
      experimental_webMcp &&
      (req.method === "GET" || req.method === "HEAD")
    ) {
      const scriptUrl = new URL(req.url);
      if (scriptUrl.searchParams.has("webmcp-script")) {
        scriptUrl.searchParams.delete("webmcp-script");
        return createWebMcpScriptHandler({
          ...experimental_webMcp,
          endpoint: scriptUrl.toString(),
        })(req);
      }
    }

    let method: string | undefined;
    let parsedBody: unknown;
    const started = Date.now();

    if (
      req.method === "POST" &&
      (req.headers.get("content-type") || "").includes("application/json")
    ) {
      try {
        parsedBody = await req.clone().json();
        if (
          typeof parsedBody === "object" &&
          parsedBody !== null &&
          "method" in parsedBody
        ) {
          method = String((parsedBody as { method: unknown }).method);
          onEvent?.(
            createEvent<McpRequestEvent>({
              type: "REQUEST_RECEIVED",
              method,
              parameters: redactEventSecret(parsedBody),
              status: "success",
            }),
          );
        }
      } catch {
        // Malformed JSON is rejected by the SDK handler below.
      }
    }

    try {
      // withMcpAuth attaches the verified AuthInfo to this Request. Pass it
      // explicitly so the SDK exposes it as ctx.http?.authInfo.
      const response = await sdkHandler.fetch(req, {
        authInfo: req.auth,
        parsedBody,
      });

      if (method) {
        onEvent?.(
          createEvent<McpRequestEvent>({
            type: "REQUEST_COMPLETED",
            method,
            duration: Date.now() - started,
            status: response.ok ? "success" : "error",
          }),
        );
      }
      return response;
    } catch (error) {
      emitError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  };
}

function redactEventSecret(body: object): object {
  const request = body as { method?: unknown; params?: unknown };
  if (
    request.method !== "events/subscribe" ||
    !request.params ||
    typeof request.params !== "object"
  )
    return body;
  const params = request.params as { delivery?: unknown };
  if (!params.delivery || typeof params.delivery !== "object") return body;
  return {
    ...body,
    params: {
      ...params,
      delivery: { ...params.delivery, secret: "[REDACTED]" },
    },
  };
}
