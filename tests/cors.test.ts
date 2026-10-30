import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "../src/index";

const endpoint = "https://mcp.example/api/mcp";

function register(server: McpServer) {
  server.registerTool(
    "echo",
    {
      description: "Echo a message",
      inputSchema: z.object({ message: z.string() }),
    },
    async ({ message }) => ({
      content: [{ type: "text", text: `Tool echo: ${message}` }],
    }),
  );
}

function preflight(origin = "https://host.example") {
  return new Request(endpoint, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers":
        "content-type, mcp-protocol-version, mcp-method, mcp-name",
    },
  });
}

function initialize(origin = "https://host.example") {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "cors-test", version: "1.0.0" },
      },
    }),
  });
}

describe("cors option", () => {
  it("adds no CORS headers when the option is not set", async () => {
    const handler = createMcpHandler(register);

    const options = await handler(preflight());
    expect(options.status).not.toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBeNull();

    const post = await handler(initialize());
    expect(post.status).toBe(200);
    expect(post.headers.get("access-control-allow-origin")).toBeNull();
    expect(post.headers.get("access-control-expose-headers")).toBeNull();
  });

  it("answers a preflight with 204 and the CORS headers", async () => {
    const handler = createMcpHandler(register, { cors: true });
    const res = await handler(preflight());

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, DELETE, OPTIONS",
    );
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "content-type, mcp-protocol-version, mcp-method, mcp-name",
    );
    expect(res.headers.get("access-control-max-age")).toBe("86400");
    expect(res.headers.get("vary")).toBe("Access-Control-Request-Headers");
    expect(await res.text()).toBe("");
  });

  it("adds CORS headers to MCP responses and keeps the response intact", async () => {
    const handler = createMcpHandler(register, { cors: true });
    const res = await handler(initialize());

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toBe(
      "mcp-session-id, mcp-protocol-version, www-authenticate",
    );
    expect(res.headers.get("content-type")).toMatch(
      /application\/json|text\/event-stream/,
    );
    expect(await res.text()).toContain('"protocolVersion"');
  });

  it("echoes only allowed origins", async () => {
    const handler = createMcpHandler(register, {
      cors: { origin: ["https://host.example"] },
    });

    const allowedPreflight = await handler(preflight("https://host.example"));
    expect(allowedPreflight.headers.get("access-control-allow-origin")).toBe(
      "https://host.example",
    );
    expect(allowedPreflight.headers.get("vary")).toContain("Origin");

    const allowedPost = await handler(initialize("https://host.example"));
    expect(allowedPost.headers.get("access-control-allow-origin")).toBe(
      "https://host.example",
    );
    expect(allowedPost.headers.get("vary")).toContain("Origin");

    const otherPreflight = await handler(preflight("https://other.example"));
    expect(otherPreflight.headers.get("access-control-allow-origin")).toBeNull();
    const otherPost = await handler(initialize("https://other.example"));
    expect(otherPost.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("accepts a single origin string", async () => {
    const handler = createMcpHandler(register, {
      cors: { origin: "https://host.example" },
    });
    const res = await handler(preflight("https://host.example"));
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://host.example",
    );
  });

  it("uses fixed allow and expose lists and maxAge when given", async () => {
    const handler = createMcpHandler(register, {
      cors: {
        allowHeaders: ["content-type", "x-api-key"],
        exposeHeaders: ["x-request-id"],
        maxAge: 600,
      },
    });

    const options = await handler(preflight());
    expect(options.headers.get("access-control-allow-headers")).toBe(
      "content-type, x-api-key",
    );
    expect(options.headers.get("access-control-max-age")).toBe("600");
    expect(options.headers.get("vary")).toBeNull();

    const post = await handler(initialize());
    expect(post.headers.get("access-control-expose-headers")).toBe(
      "mcp-session-id, mcp-protocol-version, www-authenticate, x-request-id",
    );
  });

  it.each([
    ["a 2025-era client", {}],
    [
      "a pinned 2026-07-28 client",
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    ],
  ] as const)("serves %s through the CORS wrapper", async (_, clientOptions) => {
    const handler = createMcpHandler(register, { cors: true });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("origin", "https://host.example");
        const res = await handler(new Request(url, { ...init, headers }));
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        return res;
      },
    });
    const client = new Client(
      { name: "browser-host", version: "1.0.0" },
      { capabilities: {}, ...clientOptions },
    );
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    const result = await client.callTool({
      name: "echo",
      arguments: { message: "hi" },
    });
    expect((result.content as any)[0].text).toBe("Tool echo: hi");
    await client.close();
  });
});

describe("withMcpAuth cors option", () => {
  it("answers preflights without verifying a token", async () => {
    const verifyToken = vi.fn(() => undefined);
    const handler = withMcpAuth(createMcpHandler(register), verifyToken, {
      required: true,
      cors: true,
    });

    const res = await handler(preflight());
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("adds CORS headers to the 401 challenge and exposes WWW-Authenticate", async () => {
    const handler = withMcpAuth(createMcpHandler(register), () => undefined, {
      required: true,
      cors: { origin: ["https://host.example"] },
    });

    const res = await handler(initialize("https://host.example"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://host.example",
    );
    expect(res.headers.get("access-control-expose-headers")).toContain(
      "www-authenticate",
    );
  });

  it("leaves auth responses unchanged without the option", async () => {
    const handler = withMcpAuth(createMcpHandler(register), () => undefined, {
      required: true,
    });

    const res = await handler(initialize());
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
