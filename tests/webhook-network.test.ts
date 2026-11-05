import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  experimental_verifyMcpWebhookEndpoint,
  type ExperimentalMcpEventContext,
} from "../src/index";

const target = {
  id: "sub_test",
  principal: "test:principal",
  name: "test.event",
  arguments: {},
  secret: `whsec_${Buffer.alloc(32, 13).toString("base64")}`,
};
const context: ExperimentalMcpEventContext = {
  principal: target.principal,
  authInfo: { token: "test", clientId: "test", scopes: [] },
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
});

describe("webhook address filtering with the real HTTPS transport", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "[::1]",
    "[::ffff:127.0.0.1]",
  ])("rejects the non-public literal %s without connecting", async (host) => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(
      experimental_verifyMcpWebhookEndpoint(
        { ...target, url: `https://${host}/hooks` },
        context,
      ),
    ).resolves.toEqual({ verified: false, reason: "connection_refused" });
  });

  it("validates DNS results again for each attempt", async () => {
    // Stub resolution, not the HTTP transport or the filtering agent. Both
    // answers must be rejected before opening a connection.
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockImplementation((...args: unknown[]) => {
        const options = args[1] as { all?: boolean };
        const callback = args[2] as (...values: unknown[]) => void;
        const address =
          lookup.mock.calls.length === 1 ? "10.0.0.1" : "127.0.0.1";
        queueMicrotask(() =>
          options.all
            ? callback(null, [{ address, family: 4 }])
            : callback(null, address, 4),
        );
        return undefined as never;
      });
    syncBuiltinESMExports();
    const subscription = { ...target, url: "https://receiver.example/hooks" };
    await expect(
      experimental_verifyMcpWebhookEndpoint(subscription, context),
    ).resolves.toEqual({ verified: false, reason: "connection_refused" });
    await expect(
      experimental_verifyMcpWebhookEndpoint(subscription, context),
    ).resolves.toEqual({ verified: false, reason: "connection_refused" });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
