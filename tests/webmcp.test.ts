import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler } from "../src/index";
import { nodeToWebHandler } from "./helpers";

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  execute: (args: unknown) => Promise<unknown>;
};

describe("createMcpHandler WebMCP option", () => {
  it("serves the bridge script with the embedded allowlist", async () => {
    const handler = createMcpHandler(() => {}, {
      experimental_webMcp: { tools: ["echo"] },
    });
    const res = await handler(
      new Request("https://example.com/api/mcp?webmcp-script"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    const script = await res.text();
    expect(script).toContain('"endpoint":"https://example.com/api/mcp"');
    expect(script).toContain('"tools":["echo"]');
    expect(script).toContain('"credentials":"same-origin"');
  });

  it("embeds the public endpoint URL when behind a proxy", async () => {
    const handler = createMcpHandler(() => {}, {
      experimental_webMcp: { tools: ["echo"] },
    });
    const res = await handler(
      new Request("http://localhost:3000/api/mcp?webmcp-script&v=1", {
        headers: {
          "x-forwarded-host": "example.com",
          "x-forwarded-proto": "https",
        },
      }),
    );
    const script = await res.text();
    expect(script).toContain('"endpoint":"https://example.com/api/mcp?v=1"');
  });

  it("escapes config so it cannot break out of an inline script tag", async () => {
    const handler = createMcpHandler(() => {}, {
      experimental_webMcp: {
        tools: ["</script><script>alert(1)</script>"],
      },
    });
    const response = await handler(
      new Request("http://localhost/api/mcp?webmcp-script"),
    );
    const script = await response.text();
    expect(script).not.toContain("</script>");
  });

  it("supports HEAD requests and configured cache control", async () => {
    const handler = createMcpHandler(() => {}, {
      experimental_webMcp: {
        tools: [],
        cacheControl: "private, no-store",
      },
    });
    const res = await handler(
      new Request("http://localhost/api/mcp?webmcp-script", {
        method: "HEAD",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe("");
  });

  it("requires an explicit tools allowlist", () => {
    expect(() =>
      createMcpHandler(() => {}, { experimental_webMcp: {} as never }),
    ).toThrow("`tools` must be an array of tool names");
  });
});

describe("webmcp bridge e2e", () => {
  let server: Server;
  let endpoint: string;

  beforeEach(async () => {
    const mcpHandler = createMcpHandler(
      (server) => {
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
        server.registerTool(
          "secret",
          {
            description: "Not for the web",
            inputSchema: z.object({}),
          },
          async () => ({ content: [{ type: "text", text: "secret" }] }),
        );
      },
      { experimental_webMcp: { tools: ["echo"] } },
    );

    server = createServer(nodeToWebHandler(mcpHandler));
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const port = (server.address() as AddressInfo | null)?.port;
    endpoint = `http://localhost:${port}/api/mcp`;
  });

  afterEach(() => {
    server.close();
  });

  async function runBridgeScript(): Promise<RegisteredTool[]> {
    const script = await fetch(`${endpoint}?webmcp-script`).then((response) =>
      response.text(),
    );

    const registered: RegisteredTool[] = [];
    const provider = {
      registerTool: (tool: RegisteredTool) => {
        registered.push(tool);
      },
    };
    // Shadow the globals the script feature-detects; fetch stays global.
    new Function("navigator", "document", script)(
      { modelContext: provider },
      undefined,
    );

    await vi.waitFor(() => {
      expect(registered.length).toBeGreaterThan(0);
    });
    return registered;
  }

  it("registers only allowlisted tools with the WebMCP provider", async () => {
    const registered = await runBridgeScript();
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe("echo");
    expect(registered[0].description).toBe("Echo a message");
    expect(registered[0].inputSchema).toMatchObject({
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    });
  });

  it("executes tool calls against the MCP endpoint", async () => {
    const [echo] = await runBridgeScript();
    const result = (await echo.execute({ message: "Are you there?" })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0].text).toBe("Tool echo: Are you there?");
  });

  it("is a no-op when no WebMCP provider exists", async () => {
    const script = await fetch(`${endpoint}?webmcp-script`).then((response) =>
      response.text(),
    );
    expect(() =>
      new Function("navigator", "document", script)(undefined, undefined),
    ).not.toThrow();
  });
});
