---
name: mcp-handler
description: Build MCP (Model Context Protocol) server endpoints in Next.js and Nuxt using the mcp-handler library. Use when creating API routes that expose tools, prompts, or resources to AI clients (Claude Desktop, Cursor, Windsurf), adding OAuth authorization to MCP endpoints, or setting up SSE transport with Redis.
---

# mcp-handler Usage Guide

Use the `mcp-handler` package to create MCP-compatible API endpoints in Next.js (13+) and Nuxt (3+) applications. It bridges the MCP TypeScript SDK with the Web Request/Response API used by modern frameworks.

---

## Installation

```bash
npm install mcp-handler @modelcontextprotocol/sdk zod
```

The peer dependency `@modelcontextprotocol/sdk@1.25.2` is required. Use 1.25.2 or later (earlier versions have a security vulnerability).

---

## Core API

### `createMcpHandler(initializeServer, serverOptions?, config?)`

The main entry point. Returns a `(request: Request) => Promise<Response>` handler.

```typescript
import { createMcpHandler } from "mcp-handler";

const handler = createMcpHandler(
  initializeServer,  // (server: McpServer) => void | Promise<void>
  serverOptions?,    // ServerOptions (name, version, capabilities)
  config?            // Config (basePath, Redis, SSE, logging)
);
```

**Parameters:**

- `initializeServer` -- Callback receiving an `McpServer` instance. Register tools, prompts, and resources here.
- `serverOptions` -- MCP SDK `ServerOptions` with optional `serverInfo: { name, version }`.
- `config` -- Handler configuration (see Config section).

---

## Next.js Route Setup

### File structure

Create a catch-all route at `app/api/[transport]/route.ts`. The `[transport]` segment resolves to `mcp`, `sse`, or `message`.

### Basic example

```typescript
// app/api/[transport]/route.ts
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const handler = createMcpHandler(
  (server) => {
    server.registerTool("roll_dice", {
      title: "Roll Dice",
      description: "Roll a dice with a specified number of sides.",
      inputSchema: { sides: z.number().int().min(2) },
    }, async ({ sides }) => {
      const value = 1 + Math.floor(Math.random() * sides);
      return { content: [{ type: "text", text: `You rolled a ${value}!` }] };
    });
  },
  { serverInfo: { name: "my-mcp-server", version: "1.0.0" } },
  { basePath: "/api" }
);

export { handler as GET, handler as POST };
```

**Critical:** Export the handler as both `GET` and `POST`. The `basePath` must match your file-system routing -- if your route file is at `app/api/[transport]/route.ts`, set `basePath: "/api"`.

---

## Config Options

```typescript
type Config = {
  basePath?: string;                // Base path for endpoint derivation (e.g., "/api")
  redisUrl?: string;                // Redis URL for SSE transport (defaults to REDIS_URL or KV_URL env var)
  maxDuration?: number;             // Max SSE connection duration in seconds (default: 60)
  verboseLogs?: boolean;            // Enable console logging (default: false)
  disableSse?: boolean;             // Disable SSE endpoint entirely (default: false)
  onEvent?: (event: McpEvent) => void;  // Event callback for analytics/debugging

  // Deprecated -- use basePath instead:
  streamableHttpEndpoint?: string;  // Default: "/mcp"
  sseEndpoint?: string;             // Default: "/sse"
  sseMessageEndpoint?: string;      // Default: "/message"
};
```

When `basePath` is provided, endpoints are derived as:
- `{basePath}/mcp` -- Streamable HTTP (primary transport)
- `{basePath}/sse` -- SSE (legacy, requires Redis)
- `{basePath}/message` -- SSE message endpoint

---

## Registering Tools

Use `server.registerTool()` inside the `initializeServer` callback. Define input schemas with Zod.

```typescript
import { z } from "zod";

server.registerTool("get_weather", {
  title: "Get Weather",
  description: "Get the current weather for a city.",
  inputSchema: {
    city: z.string().describe("City name"),
    units: z.enum(["celsius", "fahrenheit"]).default("celsius"),
  },
}, async ({ city, units }) => {
  const weather = await fetchWeather(city, units);
  return {
    content: [{ type: "text", text: JSON.stringify(weather) }],
  };
});
```

You can also register prompts and resources:

```typescript
server.registerPrompt("summarize", {
  description: "Summarize text",
  inputSchema: { text: z.string() },
}, async ({ text }) => {
  return { messages: [{ role: "user", content: { type: "text", text: `Summarize: ${text}` } }] };
});

server.registerResource("config://app", {
  description: "Application configuration",
}, async () => {
  return { contents: [{ uri: "config://app", text: JSON.stringify(config) }] };
});
```

---

## Authorization with `withMcpAuth`

Wrap the handler with Bearer token authentication per the MCP authorization spec.

```typescript
import { createMcpHandler, withMcpAuth } from "mcp-handler";

const handler = createMcpHandler((server) => {
  server.registerTool("secret_data", {
    title: "Secret Data",
    description: "Access protected data.",
    inputSchema: {},
  }, async (_args, extra) => {
    // Access auth info in tool handlers via extra.authInfo
    const userId = extra.authInfo?.clientId;
    return { content: [{ type: "text", text: `Hello ${userId}` }] };
  });
}, {});

const verifyToken = async (req: Request, bearerToken?: string) => {
  if (!bearerToken) return undefined;
  // Validate the token against your auth service
  const decoded = await validateToken(bearerToken);
  return {
    token: bearerToken,
    scopes: decoded.scopes,
    clientId: decoded.sub,
    expiresAt: decoded.exp,
  };
};

const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,           // Reject unauthenticated requests with 401
  requiredScopes: ["read"], // Reject tokens missing required scopes with 403
});

export { authHandler as GET, authHandler as POST };
```

**`withMcpAuth` options:**

| Option | Default | Description |
|--------|---------|-------------|
| `required` | `false` | If true, unauthenticated requests return 401 |
| `requiredScopes` | `[]` | Scopes the token must have (403 if missing) |
| `resourceMetadataPath` | `"/.well-known/oauth-protected-resource"` | Path for RFC 9728 metadata |
| `resourceUrl` | auto-detected | Explicit override for resource identifier |

Auth info propagates to tool handlers via `AsyncLocalStorage` and is accessible as `extra.authInfo`.

---

## OAuth Protected Resource Metadata (RFC 9728)

Expose a `.well-known/oauth-protected-resource` endpoint so clients can discover your authorization server.

```typescript
// app/.well-known/oauth-protected-resource/route.ts
import {
  protectedResourceHandler,
  metadataCorsOptionsRequestHandler,
} from "mcp-handler";

const handler = protectedResourceHandler({
  authServerUrls: ["https://auth.example.com"],
});
const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
```

---

## Dynamic / Multi-Tenant Routes

For per-tenant or parameterized endpoints, create the handler dynamically:

```typescript
// app/tenants/[tenantId]/[transport]/route.ts
const handler = async (
  req: Request,
  { params }: { params: Promise<{ tenantId: string }> }
) => {
  const { tenantId } = await params;
  return createMcpHandler(
    (server) => {
      // Register tenant-specific tools
      server.registerTool("get_tenant_info", {
        title: "Get Tenant Info",
        description: `Info for tenant ${tenantId}`,
        inputSchema: {},
      }, async () => {
        const info = await getTenantInfo(tenantId);
        return { content: [{ type: "text", text: JSON.stringify(info) }] };
      });
    },
    {},
    { basePath: `/tenants/${tenantId}` }
  )(req);
};

export { handler as GET, handler as POST };
```

---

## Nuxt Usage

Use `fromWebHandler` from h3 to bridge the Web Request handler:

```typescript
// server/api/mcp/[transport].ts
import { createMcpHandler } from "mcp-handler";
import { fromWebHandler } from "h3";

const handler = createMcpHandler(
  (server) => {
    // Register tools here
  },
  {},
  { basePath: "/api/mcp" }
);

export default fromWebHandler(handler);
```

---

## SSE Transport (Legacy)

SSE transport requires Redis for pub/sub coordination between the SSE connection and message endpoints.

```typescript
const handler = createMcpHandler(
  (server) => { /* ... */ },
  {},
  {
    basePath: "/api",
    redisUrl: process.env.REDIS_URL, // or set REDIS_URL / KV_URL env var
  }
);
```

SSE is deprecated in the MCP spec (as of 2025-03-26). Prefer the Streamable HTTP transport. Disable SSE entirely with `disableSse: true`.

---

## Event Monitoring

Use `onEvent` for analytics, debugging, or observability:

```typescript
const handler = createMcpHandler(
  (server) => { /* ... */ },
  {},
  {
    basePath: "/api",
    onEvent: (event) => {
      switch (event.type) {
        case "SESSION_STARTED":
        case "SESSION_ENDED":
          console.log(`Session ${event.type}`, event.sessionId);
          break;
        case "REQUEST_RECEIVED":
        case "REQUEST_COMPLETED":
          console.log(`${event.method} - ${event.status}`, event.duration);
          break;
        case "ERROR":
          console.error(`[${event.severity}] ${event.error}`, event.context);
          break;
      }
    },
  }
);
```

**Event types:**

- `SESSION_STARTED` / `SESSION_ENDED` -- Transport: `"SSE"` or `"HTTP"`, includes `clientInfo` and `sessionId`
- `REQUEST_RECEIVED` / `REQUEST_COMPLETED` -- Method name, parameters, result, duration, status
- `ERROR` -- Error object, context string, source (`"request"` | `"session"` | `"system"`), severity

---

## Utility Functions

### `getPublicOrigin(req)` / `getPublicUrl(req)`

Reconstruct the public-facing URL from proxy headers. Useful when your server is behind a reverse proxy.

```typescript
import { getPublicOrigin, getPublicUrl } from "mcp-handler";

const origin = getPublicOrigin(request); // e.g., "https://example.com"
const url = getPublicUrl(request);       // e.g., "https://example.com/api/mcp"
```

Header precedence: `X-Forwarded-Host` + `X-Forwarded-Proto` > `Forwarded` (RFC 7239) > `req.url`.

---

## CLI Scaffolding

Quickly scaffold a route:

```bash
npx mcp-handler
# or
npx create-mcp-route
```

This detects your package manager, creates `app/api/[transport]/route.ts` with a template, and installs dependencies.

---

## Important Notes

1. **Security:** Use `@modelcontextprotocol/sdk@1.25.2` or later. Earlier versions have a known vulnerability.
2. **basePath must match routing:** The `basePath` config must align with your file-system route structure.
3. **Streamable HTTP is stateless:** Each request creates a fresh transport. There is no session persistence across requests.
4. **SSE creates separate server instances:** Each SSE connection gets its own `McpServer` instance, unlike Streamable HTTP which reuses one.
5. **Redis is only needed for SSE:** The Streamable HTTP transport works without Redis.
6. **Auth errors are masked:** If `verifyToken` throws, clients receive a generic "Invalid token" 401 -- error details are not leaked.
7. **Global Request augmentation:** The auth module extends the global `Request` type with an optional `auth?: AuthInfo` property.

---

## Connecting AI Clients

Point your AI client to the Streamable HTTP endpoint:

| Client | URL to configure |
|--------|-----------------|
| Claude Desktop | `https://your-app.com/api/mcp` |
| Cursor | `https://your-app.com/api/mcp` |
| Windsurf | `https://your-app.com/api/mcp` |

For SSE (legacy): use `https://your-app.com/api/sse`.
