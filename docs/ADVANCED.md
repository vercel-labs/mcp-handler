# Advanced Usage

## Dynamic Routing

For multi-tenant or dynamic MCP servers:

```typescript
// app/dynamic/[p]/mcp/route.ts
import { createMcpHandler } from "mcp-handler";
import type { NextRequest } from "next/server";
import { z } from "zod";

const handler = async (
  req: NextRequest,
  { params }: { params: Promise<{ p: string }> },
) => {
  const { p } = await params;

  return createMcpHandler((server) => {
    server.registerTool(
      "roll_dice",
      {
        title: "Roll Dice",
        description: `Roll a dice for tenant ${p}.`,
        inputSchema: z.object({ sides: z.number().int().min(2) }),
      },
      async ({ sides }) => {
        const value = 1 + Math.floor(Math.random() * sides);
        return {
          content: [
            { type: "text", text: `🎲 Tenant ${p} rolled a ${value}!` },
          ],
        };
      },
    );
  })(req);
};

export { handler as GET, handler as POST };
```

## Options

`createMcpHandler` takes a single options object: the SDK's `ServerOptions`
(capabilities, instructions, ...) plus handler-level extras.

```typescript
type McpHandlerOptions = ServerOptions & {
  serverInfo?: { name: string; version: string }; // Reported to clients during initialization
  verboseLogs?: boolean; // Enable debug logging
  onEvent?: (event: McpEvent) => void; // Analytics/debugging callback
  maxSubscriptions?: number; // Maximum subscriptions/listen streams; 0 disables them
  cors?: boolean | CorsOptions; // CORS for browser clients on other origins (off by default)
};
```

## Browser Clients (CORS)

Browser-based MCP clients, such as MCP Apps hosts, inspectors and test
benches, call the server straight from a page. When that page is on another
origin, the browser sends an `OPTIONS` preflight first and only lets the page
read responses that carry CORS headers. Turn this on with `cors`:

```typescript
const handler = createMcpHandler(register, {
  cors: { origin: ["https://inspector.example.com"] }, // or `cors: true` for any origin
});

export { handler as GET, handler as POST, handler as DELETE, handler as OPTIONS };
```

With `cors` set, the handler:

- answers `OPTIONS` with `204`, `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`
  and `Access-Control-Max-Age` (one day by default);
- allows the request headers the preflight asks for (`Access-Control-Request-Headers`),
  which covers `authorization`, `mcp-protocol-version`, `mcp-method`, `mcp-name`,
  `mcp-session-id`, `last-event-id` and `Mcp-Param-*`;
- adds `Access-Control-Allow-Origin` to every response (the request's origin when
  it is on the list, with `Vary: Origin`) and exposes `mcp-session-id`,
  `mcp-protocol-version` and `www-authenticate`.

```typescript
type CorsOptions = {
  origin?: "*" | string | string[]; // Default "*"
  allowHeaders?: string[]; // A fixed list instead of reflecting the preflight
  exposeHeaders?: string[]; // Added to the default exposed headers
  maxAge?: number; // Preflight cache lifetime in seconds; default 86400
};
```

Remember to export the handler for `OPTIONS` in your framework. Without `cors`,
nothing changes: `OPTIONS` gets `405` and responses carry no CORS headers.

If you wrap the handler with `withMcpAuth`, pass `cors` to `withMcpAuth`
instead (see [Authorization](AUTHORIZATION.md#browser-clients-on-other-origins)).

## Nuxt Usage

```typescript
// server/routes/mcp.ts
import { createMcpHandler } from "mcp-handler";
import { fromWebHandler } from "h3";
import { z } from "zod";

const handler = createMcpHandler((server) => {
  server.registerTool(
    "roll_dice",
    {
      title: "Roll Dice",
      description: "Roll a dice with a specified number of sides.",
      inputSchema: z.object({ sides: z.number().int().min(2) }),
    },
    async ({ sides }) => {
      const value = 1 + Math.floor(Math.random() * sides);
      return {
        content: [{ type: "text", text: `🎲 You rolled a ${value}!` }],
      };
    },
  );
});

export default fromWebHandler(handler);
```
