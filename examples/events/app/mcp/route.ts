import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { events } from "../../lib/events";

const handler = createMcpHandler(
  (server) => {
    // Register tools as usual; events are served from the same route.
  },
  { events },
);

// TODO: Replace with real OAuth token verification.
const verifyToken = async (
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> => {
  if (!bearerToken?.startsWith("__TEST_VALUE__")) return undefined;
  return {
    token: bearerToken,
    scopes: ["issues:read"],
    clientId: "example-client",
    extra: { issuer: "https://auth.example.com", userId: "user-123" },
  };
};

// Events need an authenticated principal. Pin resourceUrl to the stable
// public origin, not a per-deployment URL.
const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  requiredScopes: ["issues:read"],
  resourceUrl: "https://issues-mcp.example.com",
});

export { authHandler as GET, authHandler as POST };
