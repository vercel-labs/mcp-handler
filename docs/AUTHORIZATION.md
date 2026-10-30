# Authorization

The MCP adapter supports the [MCP Authorization Specification](https://modelcontextprotocol.io/specification/draft/basic/authorization) through the `withMcpAuth` wrapper.

## Basic Usage

```typescript
// app/api/mcp/route.ts
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

const handler = createMcpHandler((server) => {
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echo a message",
      inputSchema: z.object({ message: z.string() }),
    },
    async ({ message }, ctx) => {
      // Access auth info via ctx.http?.authInfo
      const authInfo = ctx.http?.authInfo;
      return {
        content: [
          {
            type: "text",
            text: `Echo: ${message}${
              authInfo?.token ? ` for user ${authInfo.clientId}` : ""
            }`,
          },
        ],
      };
    },
  );
}, {});

// Token verification function
const verifyToken = async (
  req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> => {
  if (!bearerToken) return undefined;

  // Replace with actual token verification logic
  const isValid = bearerToken.startsWith("__TEST_VALUE__");
  if (!isValid) return undefined;

  return {
    token: bearerToken,
    scopes: ["read:stuff"],
    clientId: "user123",
    extra: { userId: "123" },
  };
};

// Wrap handler with authorization
const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  requiredScopes: ["read:stuff"],
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
});

export { authHandler as GET, authHandler as POST };
```

## Browser session cookies for WebMCP

The WebMCP bridge uses `fetch` with `credentials: "same-origin"` by default, so it automatically sends the session cookie already held by the browser. `verifyToken` receives the full request and can use that cookie when no bearer token is present:

```typescript
const verifyAuth = async (
  req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> => {
  // Preserve OAuth support for regular MCP clients.
  if (bearerToken) return verifyOAuthToken(bearerToken);

  // Only trust browser cookies on same-origin requests.
  if (req.headers.get("sec-fetch-site") !== "same-origin") return undefined;

  const sessionToken = req.headers
    .get("cookie")
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith("session="))
    ?.slice("session=".length);
  if (!sessionToken) return undefined;

  const session = await verifySession(sessionToken);
  if (!session) return undefined;

  return {
    token: sessionToken,
    scopes: ["read:stuff"],
    clientId: session.userId,
    extra: { userId: session.userId, authMethod: "cookie" },
  };
};

const authHandler = withMcpAuth(handler, verifyAuth, {
  required: true,
  requiredScopes: ["read:stuff"],
});
```

`verifyOAuthToken` and `verifySession` are calls into your auth provider or session store. Keep the session cookie `HttpOnly`, `Secure`, and `SameSite=Lax` or stricter. Do not return or log `authInfo.token` from a tool.

See the [complete cookie-auth route](../examples/auth-cookie/route.ts) and the [WebMCP bridge guide](WEBMCP.md).

## Browser clients on other origins

To let browser-based MCP clients on other origins call an authenticated
server, pass `cors` to `withMcpAuth` (not to `createMcpHandler`). The wrapper
then answers `OPTIONS` preflights before checking the token, since browsers
never send credentials on a preflight, and adds the CORS headers to the
`401`/`403` challenges with `WWW-Authenticate` exposed, so the client can find
your protected resource metadata.

```typescript
const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  cors: { origin: ["https://inspector.example.com"] },
});

export { authHandler as GET, authHandler as POST, authHandler as OPTIONS };
```

The options are the same as `createMcpHandler`'s `cors` (see
[Browser Clients](ADVANCED.md#browser-clients-cors)).

## OAuth Protected Resource Metadata

Create `app/.well-known/oauth-protected-resource/route.ts`:

```typescript
import {
  protectedResourceHandler,
  metadataCorsOptionsRequestHandler,
} from "mcp-handler";

const handler = protectedResourceHandler({
  authServerUrls: ["https://auth-server.com"],
});

const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
```

This endpoint provides:

- `resource`: The URL of your MCP server
- `authorization_servers`: Array of OAuth authorization server Issuer URLs

The path should match `resourceMetadataPath` in your `withMcpAuth` config (default: `/.well-known/oauth-protected-resource`).

## Authorization Flow

1. Client makes a request with a Bearer token in the Authorization header
2. `verifyToken` validates the token and returns auth info
3. If auth is required and fails → 401 response
4. If the token has expired → 401 response, even when scopes are also missing
5. If required scopes are missing from a valid token → 403 response
6. On success, auth info is available via `ctx.http?.authInfo` in tool handlers

## Step-up authorization

`withMcpAuth` includes the configured `requiredScopes` in the `WWW-Authenticate`
header on both `401` and `403` responses. This lets clients request the scopes
needed for the current operation during initial authorization or a later scope
upgrade, following the [MCP step-up authorization flow](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#step-up-authorization-flow).

For example, a wrapper configured with
`requiredScopes: ["files:read", "files:write"]` receiving a valid token with only
`files:read` returns the following challenge before invoking the wrapped handler:

```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope", error_description="Insufficient scope", scope="files:read files:write", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"
Content-Type: application/json

{"error":"insufficient_scope","error_description":"Insufficient scope"}
```

The challenge includes **all scopes required for the operation**, including ones
the token already grants. A supporting client combines these with its previously
requested scopes, reauthorizes through the same OAuth server, and retries the
original request with the new token. Clients should bound retries and handle
denied consent. A plain `403` without a scope challenge does not identify which
permissions to request.

Your `verifyToken` implementation must return the token's actual granted scopes
in `AuthInfo.scopes`. Your authorization server must recognize those scopes and
support issuing a token with the additional grants. The example scope names are
application-defined; this package does not define or issue scopes.

`requiredScopes` applies to every request reaching that wrapper. For requirements
that vary by tool or arguments, resolve the operation's policy in your HTTP layer
and configure the wrapper before dispatching the request. Authorize the same
operation and arguments that the MCP handler will execute. The wrapper does not
infer permissions from tool descriptions or convert downstream API failures into
scope upgrades. Existing resource-level permission checks still apply.

Set `required: true` when authentication is mandatory: `requiredScopes` alone
continues to allow requests for which `verifyToken` returns `undefined`. Omit
`requiredScopes` or pass an empty array to omit the challenge's `scope` parameter.

## CIMD (Client ID Metadata Documents)

The 2026-07-28 MCP spec deprecates Dynamic Client Registration (DCR) in favor of CIMD: OAuth clients identify themselves with an HTTPS URL (`client_id`) that serves their metadata document, removing the need for a registration round-trip.

CIMD is implemented by the **authorization server**, which advertises it via `client_id_metadata_document_supported: true` in its RFC 8414 metadata. As a resource server, your MCP deployment doesn't change beyond what this package already provides — clients discover your authorization servers through the Protected Resource Metadata endpoint above, then negotiate CIMD (or fall back to DCR during the deprecation window) directly with the authorization server. If you operate your own authorization server, enable CIMD there; DCR remains functional for backward compatibility but will be removed in a future spec revision.
