import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SpanKind } from "@opentelemetry/api";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { registerTestTracing } from "./tracing";

// The built package, loaded the way an app that mixes CommonJS and ESM would:
// `createMcpHandler` from one build and the experimental helpers from the other.
// Built inside node_modules so the bundles resolve this repo's dependencies.
const outDir = path.join(__dirname, "..", "node_modules", ".cache", "mcp-handler-dual");

type Package = typeof import("../src/index");
let cjs: Package;
let esm: Package;

beforeAll(async () => {
  execFileSync(
    "pnpm",
    ["exec", "tsup", "--out-dir", outDir, "--no-dts", "--no-sourcemap"],
    { cwd: path.join(__dirname, ".."), stdio: "ignore" },
  );
  cjs = createRequire(__filename)(path.join(outDir, "index.js"));
  esm = await import(pathToFileURL(path.join(outDir, "index.mjs")).href);
}, 60_000);

let exporter: InMemorySpanExporter;
let shutdown: () => Promise<void>;

beforeEach(() => {
  ({ exporter, shutdown } = registerTestTracing());
});

afterEach(async () => {
  await shutdown();
});

function serverSpans() {
  return exporter
    .getFinishedSpans()
    .filter((span) => span.kind === SpanKind.SERVER);
}

async function post(
  handler: (req: Request) => Promise<Response>,
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
) {
  const response = await handler(
    new Request("https://example.com/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  await response.text();
}

it("records a tool's outcome reported through the other build", async () => {
  const handler = cjs.createMcpHandler((server) => {
    server.registerTool("report", {}, async (ctx) => {
      esm.experimental_setToolOutcome(ctx, {
        outcome: "api_error",
        errorType: "forbidden",
      });
      return { isError: true, content: [{ type: "text", text: "Forbidden" }] };
    });
  });

  await post(handler, "tools/call", { name: "report", arguments: {} });

  const [span] = serverSpans();
  expect(span.attributes).toMatchObject({
    "vercel.rpc.outcome": "api_error",
    "error.type": "forbidden",
  });
});

it("writes MCP Events spans for events registered through the other build", async () => {
  const handler = esm.withMcpAuth(
    esm.createMcpHandler((server) =>
      cjs.experimental_registerMcpEvents(server, {
        getPrincipal: (auth) => String(auth.extra?.subject ?? ""),
        events: [
          {
            name: "issue.created",
            inputSchema: z.strictObject({ project: z.string() }),
            payloadSchema: z.object({ id: z.string() }),
            authorize: async () => true,
          },
        ],
        subscriptions: {
          prepare: async () => crypto.randomUUID(),
          upsert: async () => ({ cursor: null, truncated: false }),
          remove: async () => false,
        },
        delivery: { verifyEndpoint: async () => ({ verified: true }) },
      }),
    ),
    async (_req, token) =>
      token
        ? { token, clientId: "client", scopes: [], extra: { subject: token } }
        : undefined,
  );

  await post(
    handler,
    "events/subscribe",
    {
      name: "issue.created",
      arguments: { project: "ABC" },
      delivery: {
        mode: "webhook",
        url: "https://receiver.example/hook",
        secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
      },
    },
    { authorization: "Bearer alice" },
  );

  const eventSpans = exporter
    .getFinishedSpans()
    .map((span) => span.name)
    .filter((name) => name.startsWith("mcp.event."));
  expect(eventSpans).toEqual([
    "mcp.event.subscription prepare",
    "mcp.event.verify_callback",
    "mcp.event.subscription subscribe",
  ]);
});
