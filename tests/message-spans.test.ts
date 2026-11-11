import type { McpServer } from "@modelcontextprotocol/server";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, expect, it } from "vitest";
import { traceMcpMessages } from "../src/telemetry/message-spans";
import { getMcpTracing } from "../src/telemetry/otel-api";
import { registerTestTracing } from "./tracing";

let exporter: InMemorySpanExporter;
let shutdown: () => Promise<void>;

beforeEach(() => {
  ({ exporter, shutdown } = registerTestTracing());
});

afterEach(async () => {
  await shutdown();
});

it("still records a notification whose handler throws", async () => {
  const transport = {
    onmessage: undefined as ((message: unknown) => void) | undefined,
    onclose: undefined,
    send: async () => {},
  };
  const server = {
    connect: async (connected: typeof transport) => {
      connected.onmessage = () => {
        throw new Error("handler failed");
      };
    },
  } as unknown as McpServer;
  traceMcpMessages(server, getMcpTracing()!, {});
  await server.connect(transport as never);

  expect(() =>
    transport.onmessage!({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  ).toThrow("handler failed");

  expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
    "notifications/initialized",
  ]);
});
