import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createMcpHandler, withMcpAuth } from "../src/index";

const endpoint = "https://mcp.example.com/mcp";
const resourceMetadataUrl =
  "https://mcp.example.com/.well-known/oauth-protected-resource";
const requiredScopes = ["files:read", "files:write"];

function authInfo(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    token: "read-token",
    clientId: "test-client",
    scopes: ["files:read"],
    ...overrides,
  };
}

describe("withMcpAuth authorization challenges", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    {
      name: "missing token",
      auth: undefined,
      status: 401,
      error: "invalid_token",
    },
    {
      name: "insufficient scopes",
      auth: authInfo(),
      status: 403,
      error: "insufficient_scope",
    },
  ])(
    "advertises every required scope for $name",
    async ({ auth, status, error }) => {
      const execute = vi.fn(() => new Response("ok"));
      const handler = withMcpAuth(execute, async () => auth, {
        required: true,
        requiredScopes,
      });

      const response = await handler(new Request(endpoint));

      expect(response.status).toBe(status);
      expect(response.headers.get("www-authenticate")).toContain(
        `Bearer error="${error}"`,
      );
      // Include scopes already granted as well as missing ones for this operation.
      expect(response.headers.get("www-authenticate")).toContain(
        'scope="files:read files:write"',
      );
      expect(response.headers.get("www-authenticate")).toContain(
        `resource_metadata="${resourceMetadataUrl}"`,
      );
      expect(await response.json()).toMatchObject({ error });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("advertises required scopes when token verification fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const execute = vi.fn(() => new Response("ok"));
    const handler = withMcpAuth(
      execute,
      async () => {
        throw new Error("Token verification failed");
      },
      { required: true, requiredScopes },
    );

    const response = await handler(new Request(endpoint));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'scope="files:read files:write"',
    );
    expect(await response.json()).toEqual({
      error: "invalid_token",
      error_description: "Invalid token",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { code: OAuthErrorCode.InvalidToken, status: 401 },
    { code: OAuthErrorCode.InsufficientScope, status: 403 },
    { code: OAuthErrorCode.ServerError, status: 500 },
  ])(
    "returns $status without logging when token verification throws $code",
    async ({ code, status }) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const execute = vi.fn(() => new Response("ok"));
      const handler = withMcpAuth(
        execute,
        async () => {
          throw new OAuthError(code, "Rejected by verifier");
        },
        { required: true, requiredScopes },
      );

      const response = await handler(new Request(endpoint));

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: code,
        error_description: "Rejected by verifier",
      });
      expect(log).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("logs untyped token verification errors and returns 401", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("connection to db failed");
    const handler = withMcpAuth(
      () => new Response("ok"),
      async () => {
        throw failure;
      },
      { required: true },
    );

    const response = await handler(new Request(endpoint));

    expect(response.status).toBe(401);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "Unexpected error authenticating bearer token:",
      failure,
    );
  });

  it.each([undefined, []])(
    "omits scope when requiredScopes is %j",
    async (scopes) => {
      const handler = withMcpAuth(
        () => new Response("ok"),
        async () => undefined,
        {
          required: true,
          requiredScopes: scopes,
        },
      );

      const response = await handler(new Request(endpoint));

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).not.toContain("scope=");
    },
  );

  it.each([999, 1000, 0])(
    "returns 401 for expired tokens before checking scopes (expiresAt=%s)",
    async (expiresAt) => {
      vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const execute = vi.fn(() => new Response("ok"));
      const handler = withMcpAuth(
        execute,
        async () => authInfo({ expiresAt }),
        {
          required: true,
          requiredScopes,
        },
      );

      const response = await handler(new Request(endpoint));

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        'error="invalid_token"',
      );
      expect(await response.json()).toEqual({
        error: "invalid_token",
        error_description: "Token has expired",
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 1001])(
    "accepts sufficient scopes with expiresAt=%s",
    async (expiresAt) => {
      vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const verified = authInfo({ scopes: requiredScopes, expiresAt });
      const execute = vi.fn(() => new Response("ok"));
      const handler = withMcpAuth(execute, async () => verified, {
        required: true,
        requiredScopes,
      });
      const request = new Request(endpoint);

      const response = await handler(request);

      expect(response.status).toBe(200);
      expect(response.headers.has("www-authenticate")).toBe(false);
      expect(request.auth).toBe(verified);
      expect(execute).toHaveBeenCalledExactlyOnceWith(request);
    },
  );

  it("preserves optional authentication when requiredScopes is configured", async () => {
    const execute = vi.fn(() => new Response("ok"));
    const handler = withMcpAuth(execute, async () => undefined, {
      requiredScopes,
    });

    expect((await handler(new Request(endpoint))).status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe.each(["2025-11-25", "2026-07-28"])(
  "step-up retry with MCP %s",
  (protocolVersion) => {
    it("challenges before tool execution and runs the retry once with upgraded scopes", async () => {
      const execute = vi.fn(async (_args: { text: string }) => ({
        content: [{ type: "text" as const, text: "File written" }],
      }));
      const handler = withMcpAuth(
        createMcpHandler((server) => {
          server.registerTool(
            "write_file",
            {
              inputSchema: z.object({ text: z.string() }),
            },
            execute,
          );
        }),
        async (_req, token) =>
          token === "write-token"
            ? authInfo({ token, scopes: requiredScopes })
            : token === "read-token"
              ? authInfo()
              : undefined,
        { required: true, requiredScopes },
      );
      const modern = protocolVersion === "2026-07-28";
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "write_file",
          arguments: { text: "Hello" },
          ...(modern
            ? {
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": protocolVersion,
                  "io.modelcontextprotocol/clientInfo": {
                    name: "step-up-test",
                    version: "1",
                  },
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              }
            : {}),
        },
      });
      const request = (token: string) =>
        new Request(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            "mcp-protocol-version": protocolVersion,
            ...(modern
              ? { "mcp-method": "tools/call", "mcp-name": "write_file" }
              : {}),
          },
          body,
        });

      const challenge = await handler(request("read-token"));
      expect(challenge.status).toBe(403);
      expect(challenge.headers.get("www-authenticate")).toContain(
        'scope="files:read files:write"',
      );
      expect(execute).not.toHaveBeenCalled();

      const response = await handler(request("write-token"));
      expect(response.status).toBe(200);
      const text = await response.text();
      const result = response.headers
        .get("content-type")
        ?.includes("text/event-stream")
        ? text
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)))
            .find((message) => message.id === 1)
        : JSON.parse(text);
      expect(result).toMatchObject({
        id: 1,
        result: { content: [{ type: "text", text: "File written" }] },
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][0]).toEqual({ text: "Hello" });
    });
  },
);
