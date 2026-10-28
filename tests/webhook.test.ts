import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { request } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "standardwebhooks";
import { z } from "zod";
import {
  experimental_deliverMcpEvent,
  experimental_verifyMcpWebhookEndpoint,
  type ExperimentalMcpEventContext,
  type ExperimentalMcpEventDeliveryOptions,
  type ExperimentalMcpWebhookSubscription,
} from "../src/index";

vi.mock("node:https", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:https")>()),
  request: vi.fn(),
}));

const secret = `whsec_${Buffer.alloc(32, 11).toString("base64")}`;
const oldSecret = `whsec_${Buffer.alloc(32, 22).toString("base64")}`;
const target = (): ExperimentalMcpWebhookSubscription => ({
  id: "sub_test",
  principal: "tenant:user",
  name: "issue.created",
  arguments: { project: "ABC" },
  url: "https://receiver.example/hooks",
  secret,
  refreshBefore: new Date(Date.now() + 60_000).toISOString(),
  cursor: "unsafe-requested-replay-position",
});
const context = (
  signal = new AbortController().signal,
): ExperimentalMcpEventContext => ({
  principal: "tenant:user",
  authInfo: { token: "token", clientId: "app", scopes: [] },
  signal,
});
const options = (): ExperimentalMcpEventDeliveryOptions => ({
  event: {
    name: "issue.created",
    inputSchema: z.strictObject({ project: z.string() }),
    payloadSchema: z.strictObject({ id: z.string(), title: z.string() }),
    authorize: vi.fn(async () => true),
  },
  subscription: target(),
  payload: { id: "issue-1", title: "hello 🌎" },
  eventId: "evt_1",
  timestamp: new Date("2026-10-07T12:00:00Z"),
});

type Exchange = {
  body: string;
  headers: Record<string, string>;
  response: PassThrough & { statusCode: number; complete: boolean };
  req: EventEmitter & {
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
};
function receiver(handle: (exchange: Exchange) => void, status = 200) {
  const exchanges: Exchange[] = [];
  vi.mocked(request).mockImplementation((...args: unknown[]) => {
    const settings = args[1] as { headers: Record<string, string> };
    const callback = args[2] as (response: Exchange["response"]) => void;
    const response = Object.assign(new PassThrough(), {
      statusCode: status,
      complete: false,
    });
    const req = Object.assign(new EventEmitter(), {
      end: vi.fn((body: string) => {
        const exchange = { body, headers: settings.headers, response, req };
        exchanges.push(exchange);
        queueMicrotask(() => {
          callback(response);
          handle(exchange);
        });
      }),
      destroy: vi.fn(() => response.destroy()),
    });
    return req as never;
  });
  return exchanges;
}
function acknowledge({ response }: Exchange, body = "") {
  response.complete = true;
  response.end(body);
}
function echo(exchange: Exchange) {
  acknowledge(
    exchange,
    JSON.stringify({ challenge: JSON.parse(exchange.body).challenge }),
  );
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("webhook callback verification", () => {
  it("sends a signed single-use challenge with the subscription routing header", async () => {
    const exchanges = receiver(echo);
    await expect(
      experimental_verifyMcpWebhookEndpoint(target(), context()),
    ).resolves.toEqual({ verified: true });
    await expect(
      experimental_verifyMcpWebhookEndpoint(target(), context()),
    ).resolves.toEqual({ verified: true });
    expect(exchanges[0].headers["webhook-id"]).toMatch(/^msg_verification_/);
    expect(exchanges[0].headers["x-mcp-subscription-id"]).toBe("sub_test");
    const first = new Webhook(secret).verify(
      exchanges[0].body,
      exchanges[0].headers,
    );
    expect(first).toMatchObject({
      type: "verification",
      challenge: expect.any(String),
    });
    expect(exchanges[0].body).not.toBe(exchanges[1].body);
  });

  it.each([
    "{}",
    "null",
    "not json",
    '{"challenge":"wrong"}',
    '{"challenge":12}',
    '{"challenge":"é"}',
  ])("does not establish consent from %s", async (body) => {
    receiver((exchange) => acknowledge(exchange, body));
    await expect(
      experimental_verifyMcpWebhookEndpoint(target(), context()),
    ).resolves.toEqual({ verified: false, reason: "challenge_failed" });
  });

  it("compares byte lengths before comparing a multibyte challenge", async () => {
    receiver((exchange) =>
      acknowledge(
        exchange,
        JSON.stringify({
          challenge: "é".repeat(JSON.parse(exchange.body).challenge.length),
        }),
      ),
    );
    await expect(
      experimental_verifyMcpWebhookEndpoint(target(), context()),
    ).resolves.toEqual({ verified: false, reason: "challenge_failed" });
  });

  it.each([302, 401, 503])(
    "returns safe categories for HTTP %s without endpoint content",
    async (status) => {
      receiver(
        (exchange) => acknowledge(exchange, "sensitive endpoint response"),
        status,
      );
      await expect(
        experimental_verifyMcpWebhookEndpoint(target(), context()),
      ).resolves.toEqual({
        verified: false,
        reason:
          status === 302
            ? "challenge_failed"
            : status === 401
            ? "http_4xx"
            : "http_5xx",
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});

describe("single-attempt event delivery", () => {
  it("validates the current policy, sends the wire envelope, and signs the exact UTF-8 bytes", async () => {
    const exchanges = receiver(acknowledge);
    const input = options();
    await expect(experimental_deliverMcpEvent(input)).resolves.toEqual({
      ok: true,
    });
    expect(input.event.authorize).toHaveBeenCalledWith(
      { project: "ABC" },
      { principal: "tenant:user", signal: expect.any(AbortSignal) },
    );
    const { body, headers } = exchanges[0];
    expect(new Webhook(secret).verify(body, headers)).toEqual({
      eventId: "evt_1",
      name: "issue.created",
      timestamp: input.timestamp.toISOString(),
      data: input.payload,
      cursor: null,
    });
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["content-length"]).toBe(Buffer.byteLength(body));
    expect(headers["webhook-id"]).toBe("evt_1");
    expect(headers["x-mcp-subscription-id"]).toBe("sub_test");
    expect(() => new Webhook(secret).verify(body + " ", headers)).toThrow();
  });

  it("supports no-expiry subscriptions, explicit safe watermarks, and key rotation", async () => {
    const exchanges = receiver(acknowledge);
    const input = options();
    input.subscription.refreshBefore = null;
    input.subscription.secret = secret.replace(/=+$/, "");
    await experimental_deliverMcpEvent({
      ...input,
      cursor: "acked-123",
      previousSecrets: [oldSecret],
    });
    const { body, headers } = exchanges[0];
    expect(new Webhook(secret).verify(body, headers)).toMatchObject({
      cursor: "acked-123",
    });
    expect(new Webhook(oldSecret).verify(body, headers)).toMatchObject({
      cursor: "acked-123",
    });
    expect(headers["webhook-signature"].split(" ")).toHaveLength(2);
  });

  it("re-signs retries while preserving event identity and occurrence time", async () => {
    vi.useFakeTimers();
    const exchanges = receiver(acknowledge);
    const input = options();
    await experimental_deliverMcpEvent(input);
    vi.setSystemTime(Date.now() + 1_000);
    await experimental_deliverMcpEvent(input);
    expect(exchanges[0].body).toBe(exchanges[1].body);
    expect(exchanges[0].headers["webhook-id"]).toBe(
      exchanges[1].headers["webhook-id"],
    );
    expect(exchanges[0].headers["webhook-timestamp"]).not.toBe(
      exchanges[1].headers["webhook-timestamp"],
    );
    expect(exchanges[0].headers["webhook-signature"]).not.toBe(
      exchanges[1].headers["webhook-signature"],
    );
  });

  it.each([200, 204, 302, 400, 410, 413, 425, 429, 500, 503])(
    "classifies HTTP %s without performing retries or following redirects",
    async (status) => {
      receiver(acknowledge, status);
      const result = await experimental_deliverMcpEvent(options());
      if (status < 300) expect(result).toEqual({ ok: true });
      else
        expect(result).toEqual({
          ok: false,
          status,
          retryable: ![302, 410, 413].includes(status),
          reason:
            status === 302
              ? "redirect"
              : status >= 500
              ? "http_5xx"
              : "http_4xx",
        });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "expired",
    "forbidden",
    "invalid_payload",
    "invalid_arguments",
    "event_mismatch",
  ])("does not send when validation fails: %s", async (code) => {
    receiver(acknowledge);
    const input = options();
    if (code === "expired")
      input.subscription.refreshBefore = new Date(Date.now() - 1).toISOString();
    if (code === "forbidden") input.event.authorize = () => false;
    if (code === "invalid_payload") input.payload = { wrong: true };
    if (code === "invalid_arguments")
      input.subscription.arguments = { wrong: true };
    if (code === "event_mismatch") input.subscription.name = "another.event";
    await expect(experimental_deliverMcpEvent(input)).rejects.toMatchObject({
      code,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rechecks expiry after asynchronous authorization", async () => {
    receiver(acknowledge);
    vi.useFakeTimers();
    const input = options();
    input.event.authorize = async () => {
      vi.setSystemTime(Date.now() + 61_000);
      return true;
    };
    await expect(experimental_deliverMcpEvent(input)).rejects.toMatchObject({
      code: "expired",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("propagates policy backend failures without sending", async () => {
    receiver(acknowledge);
    const input = options();
    const error = new Error("policy unavailable");
    input.event.authorize = async () => {
      throw error;
    };
    await expect(experimental_deliverMcpEvent(input)).rejects.toBe(error);
    expect(request).not.toHaveBeenCalled();
  });

  it("snapshots input before asynchronous authorization", async () => {
    const exchanges = receiver(acknowledge);
    const input = options();
    input.event.authorize = async () => {
      input.subscription.url = "https://different.example/hooks";
      (input.payload as { title: string }).title = "changed";
      input.timestamp.setUTCFullYear(2000);
      return true;
    };
    await experimental_deliverMcpEvent(input);
    expect(vi.mocked(request).mock.calls[0][0]).toBe(
      "https://receiver.example/hooks",
    );
    expect(JSON.parse(exchanges[0].body)).toMatchObject({
      data: { title: "hello 🌎" },
      timestamp: "2026-10-07T12:00:00.000Z",
    });
  });

  it("ignores application metadata when snapshotting subscription state", async () => {
    receiver(acknowledge);
    const input = options();
    Object.assign(input.subscription, {
      updatedAt: new Date(),
      optional: undefined,
    });
    await expect(experimental_deliverMcpEvent(input)).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects oversized envelopes before sending", async () => {
    receiver(acknowledge);
    await expect(
      experimental_deliverMcpEvent({
        ...options(),
        payload: { id: "x", title: "x".repeat(256 * 1024) },
      }),
    ).rejects.toThrow("256 KiB");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("bounded outbound transport", () => {
  it.each(["development", "test", "production"])(
    "uses the private filtering agent in %s",
    async (environment) => {
      vi.stubEnv("NODE_ENV", environment);
      receiver(acknowledge);
      await experimental_deliverMcpEvent(options());
      const settings = vi.mocked(request).mock.calls[0][1] as {
        agent: { keepAlive: boolean; constructor: { name: string } };
      };
      expect(settings.agent.constructor.name).toBe(
        "RequestFilteringHttpsAgent",
      );
      expect(settings.agent.keepAlive).toBe(false);
    },
  );

  it.each([
    "http://receiver.example/hooks",
    "https://user:password@receiver.example/hooks",
    "https://receiver.example/hooks#fragment",
  ])("rejects invalid callback URLs before requesting: %s", async (url) => {
    receiver(acknowledge);
    const subscription = { ...target(), url };
    await expect(
      experimental_verifyMcpWebhookEndpoint(subscription, context()),
    ).rejects.toThrow();
    await expect(
      experimental_deliverMcpEvent({ ...options(), subscription }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["", "not-a-secret", "whsec_aA=="])(
    "rejects invalid secrets before sending: %s",
    async (key) => {
      receiver(acknowledge);
      await expect(
        experimental_deliverMcpEvent({ ...options(), previousSecrets: [key] }),
      ).rejects.toThrow("Invalid Standard Webhooks secret");
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects identifiers that cannot be safely sent as headers", async () => {
    receiver(acknowledge);
    await expect(
      experimental_deliverMcpEvent({ ...options(), eventId: "bad\r\nid" }),
    ).rejects.toThrow("Invalid webhook identifier");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["ECONNRESET", "ENOTFOUND", "CERT_HAS_EXPIRED"])(
    "returns safe transport failures for %s",
    async (code) => {
      receiver(({ req }) =>
        req.emit(
          "error",
          Object.assign(new Error("sensitive endpoint details"), { code }),
        ),
      );
      await expect(experimental_deliverMcpEvent(options())).resolves.toEqual({
        ok: false,
        reason:
          code === "CERT_HAS_EXPIRED" ? "tls_error" : "connection_refused",
        retryable: true,
      });
    },
  );

  it("bounds response bytes and terminates the response stream", async () => {
    const exchanges = receiver(({ response }) =>
      response.write(Buffer.alloc(64 * 1024 + 1)),
    );
    await expect(
      experimental_verifyMcpWebhookEndpoint(target(), context()),
    ).resolves.toEqual({ verified: false, reason: "challenge_failed" });
    expect(exchanges[0].response.destroyed).toBe(true);
  });

  it("treats a truncated response as a retryable transport failure", async () => {
    receiver(({ response }) => response.destroy());
    await expect(experimental_deliverMcpEvent(options())).resolves.toEqual({
      ok: false,
      reason: "connection_refused",
      retryable: true,
    });
  });

  it("bounds stalled responses by a total deadline", async () => {
    vi.useFakeTimers();
    const exchanges = receiver(() => {});
    const result = experimental_deliverMcpEvent(options());
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(result).resolves.toEqual({
      ok: false,
      reason: "timeout",
      retryable: true,
    });
    expect(exchanges[0].req.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects caller cancellation and tears down the request", async () => {
    const abort = new AbortController();
    const reason = new Error("worker cancelled");
    const exchanges = receiver(() => abort.abort(reason));
    await expect(
      experimental_deliverMcpEvent({ ...options(), signal: abort.signal }),
    ).rejects.toBe(reason);
    expect(exchanges[0].req.destroy).toHaveBeenCalled();
  });

  it("does not dispatch with an already-aborted signal", async () => {
    receiver(acknowledge);
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(
      experimental_deliverMcpEvent({ ...options(), signal }),
    ).rejects.toThrow("cancelled");
    await expect(
      experimental_verifyMcpWebhookEndpoint(target(), context(signal)),
    ).rejects.toThrow("cancelled");
    expect(request).not.toHaveBeenCalled();
  });
});
