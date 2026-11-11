import { afterEach, describe, expect, it, vi } from "vitest";

const { registerOTel } = vi.hoisted(() => ({ registerOTel: vi.fn() }));
vi.mock("@vercel/otel", () => ({ registerOTel }));

import { registerMcpOTel } from "../src/otel";

afterEach(() => {
  registerOTel.mockReset();
  vi.unstubAllEnvs();
});

function registeredConfiguration() {
  expect(registerOTel).toHaveBeenCalledOnce();
  return registerOTel.mock.calls[0][0];
}

describe("registerMcpOTel", () => {
  it("names the service after the Vercel project, as default tracing does", () => {
    vi.stubEnv("VERCEL_PROJECT_NAME", "my-mcp");
    vi.stubEnv("OTEL_SERVICE_NAME", "");

    registerMcpOTel();

    const configuration = registeredConfiguration();
    expect(configuration.serviceName).toBe("my-mcp");
    expect(configuration.spanProcessors).toEqual([
      expect.objectContaining({ onStart: expect.any(Function) }),
      "auto",
    ]);
  });

  it("keeps the caller's configuration, with redaction ahead of its processors", () => {
    const processor = {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      forceFlush: vi.fn(),
      shutdown: vi.fn(),
    };

    registerMcpOTel({
      serviceName: "custom",
      spanProcessors: [processor, "auto"],
      attributes: { env: "test" },
    });

    const configuration = registeredConfiguration();
    expect(configuration).toMatchObject({
      serviceName: "custom",
      attributes: { env: "test" },
    });
    expect(configuration.spanProcessors).toHaveLength(3);
    expect(configuration.spanProcessors.slice(1)).toEqual([processor, "auto"]);
  });

  it("removes the raw user agent and referer when a span starts", () => {
    registerMcpOTel();
    const [redact] = registeredConfiguration().spanProcessors;
    const span = {
      attributes: {
        "http.user_agent": "Cursor/1.0.0 (darwin arm64)",
        "http.referer": "https://example.com/private",
        "http.host": "mcp.example.com",
      },
    };

    redact.onStart(span);

    expect(span.attributes).toEqual({ "http.host": "mcp.example.com" });
  });
});
