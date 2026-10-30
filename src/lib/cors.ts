/**
 * CORS settings for browser-based MCP clients (MCP Apps hosts, inspectors,
 * test benches) that call the server from a page on another origin.
 */
export type CorsOptions = {
  /**
   * Origins allowed to call the handler from a browser. `"*"` allows any
   * origin. A single origin or a list (full origins such as
   * `"https://app.example.com"`) echoes the request's `Origin` back only when
   * it matches, and adds `Vary: Origin`.
   * @default "*"
   */
  origin?: "*" | string | string[];
  /**
   * Request headers a browser may send. By default the preflight's
   * `Access-Control-Request-Headers` is reflected, which covers the MCP
   * headers (`mcp-protocol-version`, `mcp-method`, `mcp-name`,
   * `mcp-session-id`, `last-event-id`, `Mcp-Param-*`) and `authorization`.
   */
  allowHeaders?: string[];
  /**
   * Extra response headers to expose to the page, in addition to
   * `mcp-session-id`, `mcp-protocol-version` and `www-authenticate`.
   */
  exposeHeaders?: string[];
  /**
   * How long, in seconds, browsers may cache a preflight response.
   * @default 86400
   */
  maxAge?: number;
};

const ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const EXPOSE_HEADERS = [
  "mcp-session-id",
  "mcp-protocol-version",
  "www-authenticate",
];

/**
 * Wraps a Web-standard handler so it answers CORS preflights with `204` and
 * adds CORS headers to every response. `true` means `{ origin: "*" }`.
 */
export function withCors(
  handler: (req: Request) => Response | Promise<Response>,
  cors: true | CorsOptions,
): (req: Request) => Promise<Response> {
  const {
    origin = "*",
    allowHeaders,
    exposeHeaders = [],
    maxAge = 86400,
  }: CorsOptions = cors === true ? {} : cors;
  const allowedOrigins =
    origin === "*" ? undefined : Array.isArray(origin) ? origin : [origin];
  const exposed = [...new Set([...EXPOSE_HEADERS, ...exposeHeaders])].join(
    ", ",
  );

  const setOrigin = (req: Request, headers: Headers) => {
    if (!allowedOrigins) {
      headers.set("Access-Control-Allow-Origin", "*");
      return;
    }
    appendVary(headers, "Origin");
    const requestOrigin = req.headers.get("origin");
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      headers.set("Access-Control-Allow-Origin", requestOrigin);
    }
  };

  return async (req: Request) => {
    if (req.method === "OPTIONS") {
      const headers = new Headers();
      setOrigin(req, headers);
      headers.set("Access-Control-Allow-Methods", ALLOW_METHODS);
      if (allowHeaders) {
        headers.set("Access-Control-Allow-Headers", allowHeaders.join(", "));
      } else {
        appendVary(headers, "Access-Control-Request-Headers");
        const requested = req.headers.get("access-control-request-headers");
        if (requested) headers.set("Access-Control-Allow-Headers", requested);
      }
      headers.set("Access-Control-Max-Age", String(maxAge));
      return new Response(null, { status: 204, headers });
    }

    const response = await handler(req);
    // Responses from fetch() have immutable headers, so copy them.
    const headers = new Headers(response.headers);
    setOrigin(req, headers);
    headers.set("Access-Control-Expose-Headers", exposed);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function appendVary(headers: Headers, value: string) {
  const vary = headers.get("vary");
  const values = vary?.split(",").map((v) => v.trim().toLowerCase()) ?? [];
  if (!values.includes(value.toLowerCase())) headers.append("Vary", value);
}
