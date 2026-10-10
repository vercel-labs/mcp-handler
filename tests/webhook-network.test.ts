import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sendWebhookControl,
  verifyWebhookEndpoint,
  type WebhookNetworkOptions,
} from "../src/events/webhook";
import type { ExperimentalMcpEventContext as McpEventContext } from "../src/events/types";

const target = {
  id: "sub_test",
  principal: "test:principal",
  name: "test.event",
  arguments: {},
  secret: `whsec_${Buffer.alloc(32, 13).toString("base64")}`,
};
const context: McpEventContext = {
  principal: target.principal,
  authInfo: { token: "test", clientId: "test", scopes: [] },
  signal: new AbortController().signal,
};

const gap = (url: string, network?: WebhookNetworkOptions) =>
  sendWebhookControl({
    subscription: { ...target, url },
    control: { type: "gap", cursor: "c1" },
    network,
  });

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
      verifyWebhookEndpoint(
        { ...target, url: `https://${host}/hooks` },
        context,
      ),
    ).resolves.toEqual({ verified: false, reason: "connection_refused" });
  });

  it.each(["127.0.0.1", "[fd00::1]"])(
    "reports %s as a non-retryable blocked destination",
    async (host) => {
      await expect(gap(`https://${host}/hooks`)).resolves.toEqual({
        ok: false,
        reason: "blocked_destination",
        retryable: false,
      });
    },
  );

  it("connects to explicitly allowed private addresses only", async () => {
    // A plain TCP listener: the TLS handshake fails after the address check.
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const { port } = server.address() as AddressInfo;
      const url = `https://127.0.0.1:${port}/hooks`;
      await expect(gap(url)).resolves.toMatchObject({
        reason: "blocked_destination",
      });
      expect(connections).toBe(0);
      await expect(
        gap(url, { allowIPAddressList: ["10.0.0.0/8"] }),
      ).resolves.toMatchObject({ reason: "blocked_destination" });
      expect(connections).toBe(0);
      await expect(
        gap(url, { allowIPAddressList: ["127.0.0.0/8"] }),
      ).resolves.toMatchObject({ ok: false, retryable: true });
      expect(connections).toBe(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
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
    await expect(verifyWebhookEndpoint(subscription, context)).resolves.toEqual(
      { verified: false, reason: "connection_refused" },
    );
    await expect(gap(subscription.url)).resolves.toEqual({
      ok: false,
      reason: "blocked_destination",
      retryable: false,
    });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
