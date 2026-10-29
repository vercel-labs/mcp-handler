import { describe, it, expect, beforeEach, afterEach, vi, Mock } from "vitest";
import { z } from "zod";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "../src/index";
import { withMcpAuth } from "../src/auth/auth-wrapper";
import { nodeToWebHandler } from "./helpers";

const serverInfo = {
  name: "e2e-server",
  version: "1.2.3",
  title: "E2E Server",
  description: "A server for the end-to-end tests.",
  websiteUrl: "https://example.com",
  icons: [{ src: "https://example.com/icon.png", mimeType: "image/png" }],
};

describe("e2e", () => {
  let server: Server;
  let endpoint: string;
  let client: Client;
  let verifyTokenMock: Mock;

  beforeEach(async () => {
    const _mcpHandler = createMcpHandler(
      (server) => {
        server.registerTool(
          "echo",
          {
            description: "Echo a message",
            inputSchema: z.object({ message: z.string() }),
          },
          async ({ message }, ctx) => {
            const token = ctx.http?.authInfo?.token;
            return {
              content: [
                {
                  type: "text",
                  text: `Tool echo: ${message}${token ? ` for ${token}` : ""}`,
                },
              ],
            };
          },
        );

        server.registerPrompt(
          "greeting",
          {
            description: "Generate a greeting message",
            argsSchema: z.object({
              name: z.string().describe("The name of the person to greet"),
            }),
          },
          async ({ name }) => {
            return {
              messages: [
                {
                  role: "user" as const,
                  content: {
                    type: "text" as const,
                    text: `Hello, ${name}! Welcome to the MCP server.`,
                  },
                },
              ],
            };
          },
        );

        server.registerResource(
          "test-resource",
          "test://example/resource",
          {
            description: "A test resource",
            mimeType: "text/plain",
          },
          async () => {
            return {
              contents: [
                {
                  uri: "test://example/resource",
                  text: "This is test resource content",
                  mimeType: "text/plain",
                },
              ],
            };
          },
        );
      },
      {
        capabilities: {
          tools: {
            listChanged: true,
          },
          prompts: {
            listChanged: true,
          },
          resources: {
            listChanged: true,
            subscribe: true,
          },
        },
        serverInfo,
        verboseLogs: true,
      },
    );

    verifyTokenMock = vi.fn((req) => {
      const header = req.headers.get("Authorization");
      if (header?.startsWith("Bearer ")) {
        const token = header.slice(7).trim();
        return Promise.resolve({
          token,
          clientId: "client1",
          scopes: ["read:stuff"],
        });
      }
      return undefined;
    });

    const mcpHandler = withMcpAuth(_mcpHandler, verifyTokenMock);

    server = createServer(nodeToWebHandler(mcpHandler));
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        resolve();
      });
    });
    const port = (server.address() as AddressInfo | null)?.port;
    endpoint = `http://localhost:${port}/custom/mcp-endpoint`;

    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    client = new Client(
      {
        name: "example-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );
    await client.connect(transport);
  });

  afterEach(() => {
    server.close();
  });

  it("should read server capabilities", async () => {
    const capabilities = client.getServerCapabilities();
    expect(capabilities).toBeDefined();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.prompts).toBeDefined();
    expect(capabilities?.resources).toBeDefined();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "echo",
      description: "Echo a message",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
          },
        },
        required: ["message"],
      },
    });
    expect((await client.listPrompts()).prompts).toStrictEqual([
      {
        arguments: [
          {
            description: "The name of the person to greet",
            name: "name",
            required: true,
          },
        ],
        description: "Generate a greeting message",
        name: "greeting",
      },
    ]);
    expect((await client.listResources()).resources).toStrictEqual([
      {
        description: "A test resource",
        mimeType: "text/plain",
        name: "test-resource",
        uri: "test://example/resource",
      },
    ]);
  });

  it("should report the server's metadata", async () => {
    expect(client.getServerVersion()).toEqual(serverInfo);
  });

  it("should list tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toEqual(1);

    const echo = tools.find((tool) => tool.name === "echo");
    expect(echo).toBeDefined();
    expect(echo?.description).toEqual("Echo a message");
  });

  it("should list prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.length).toEqual(1);

    const greeting = prompts.find((prompt) => prompt.name === "greeting");
    expect(greeting).toBeDefined();
    expect(greeting?.description).toEqual("Generate a greeting message");
    expect(greeting?.arguments).toBeDefined();
    expect(greeting?.arguments?.length).toBeGreaterThan(0);
  });

  it("should get a prompt", async () => {
    const result = await client.getPrompt({
      name: "greeting",
      arguments: {
        name: "Alice",
      },
    });
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toEqual(1);
    expect(result.messages[0].role).toEqual("user");
    expect(result.messages[0].content.type).toEqual("text");
    if (result.messages[0].content.type === "text") {
      expect(result.messages[0].content.text).toContain("Hello, Alice!");
    }
  });

  it("should list resources", async () => {
    const { resources } = await client.listResources();
    expect(resources.length).toEqual(1);

    const testResource = resources.find(
      (resource) => resource.name === "test-resource",
    );
    expect(testResource).toBeDefined();
    expect(testResource?.uri).toEqual("test://example/resource");
    expect(testResource?.description).toEqual("A test resource");
  });

  it("should read a resource", async () => {
    const result = await client.readResource({
      uri: "test://example/resource",
    });
    expect(result.contents).toBeDefined();
    expect(result.contents.length).toEqual(1);
    expect(result.contents[0].uri).toEqual("test://example/resource");
    expect("text" in result.contents[0]).toBe(true);
    if ("text" in result.contents[0]) {
      expect(result.contents[0].text).toEqual("This is test resource content");
    }
  });

  it("should call a tool", async () => {
    const result = await client.callTool({
      name: "echo",
      arguments: {
        message: "Are you there?",
      },
    });
    expect((result.content as any)[0].text).toEqual(
      "Tool echo: Are you there?",
    );
  });

  it("should call a tool with auth", async () => {
    const authenticatedTransport = new StreamableHTTPClientTransport(
      new URL(endpoint),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ACCESS_TOKEN`,
          },
        },
      },
    );
    const authenticatedClient = new Client(
      {
        name: "example-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );
    await authenticatedClient.connect(authenticatedTransport);
    const result = await authenticatedClient.callTool({
      name: "echo",
      arguments: {
        message: "Are you there?",
      },
    });
    expect((result.content as any)[0].text).toEqual(
      "Tool echo: Are you there? for ACCESS_TOKEN",
    );
  });

  it("should serve the 2026-07-28 protocol to a pinned modern client", async () => {
    const modernTransport = new StreamableHTTPClientTransport(
      new URL(endpoint),
    );
    const modernClient = new Client(
      {
        name: "modern-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: "2026-07-28" } },
      },
    );
    await modernClient.connect(modernTransport);

    const { tools } = await modernClient.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toEqual("echo");

    const result = await modernClient.callTool({
      name: "echo",
      arguments: {
        message: "Hello from the future",
      },
    });
    expect((result.content as any)[0].text).toEqual(
      "Tool echo: Hello from the future",
    );
  });

  it("should pass auth info through on the modern protocol path", async () => {
    const modernTransport = new StreamableHTTPClientTransport(
      new URL(endpoint),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ACCESS_TOKEN`,
          },
        },
      },
    );
    const modernClient = new Client(
      {
        name: "modern-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: "2026-07-28" } },
      },
    );
    await modernClient.connect(modernTransport);
    const result = await modernClient.callTool({
      name: "echo",
      arguments: {
        message: "Are you there?",
      },
    });
    expect((result.content as any)[0].text).toEqual(
      "Tool echo: Are you there? for ACCESS_TOKEN",
    );
  });

  it("should return an invalid token error when verifyToken fails", async () => {
    const authenticatedTransport = new StreamableHTTPClientTransport(
      new URL(endpoint),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ACCESS_TOKEN`,
          },
        },
      },
    );
    const authenticatedClient = new Client(
      {
        name: "example-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );
    verifyTokenMock.mockImplementation(() => {
      throw new Error("JWT signature failed, or something");
    });

    await expect(
      authenticatedClient.connect(authenticatedTransport),
    ).rejects.toThrow("Invalid token");
  });
});
