import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { request } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "standardwebhooks";
import { z } from "zod";
import {
  deliverWebhookEvent,
  sendWebhookControl,
  verifyWebhookEndpoint,
  type WebhookControl,
  type WebhookEventDeliveryOptions,
} from "../src/events/webhook";
import type {
  ExperimentalMcpEventContext as McpEventContext,
  ExperimentalMcpWebhookSubscription as McpWebhookSubscription,
} from "../src/events/types";

vi.mock("node:https", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:https")>()),
  request: vi.fn(),
}));

const secret = `whsec_${Buffer.alloc(32, 11).toString("base64")}`;
const oldSecret = `whsec_${Buffer.alloc(32, 22).toString("base64")}`;
const target = (): McpWebhookSubscription => ({
  id: "sub_test",
  principal: "tenant:user",
  name: "issue.created",
  arguments: { project: "ABC" },
  url: "https://receiver.example/hooks",
  secret,
  refreshBefore: new Date(Date.now() + 60_000).toISOString(),
  cursor: "unsafe-requested-replay-position",
});
const context = (signal = new AbortController().signal): McpEventContext => ({
  principal: "tenant:user",
  authInfo: { token: "token", clientId: "app", scopes: [] },
  signal,
});
const options = (): WebhookEventDeliveryOptions => ({
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
  response: PassThrough & {
    statusCode: number;
    headers: Record<string, string>;
    complete: boolean;
  };
  req: EventEmitter & {
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
};
function receiver(
  handle: (exchange: Exchange) => void,
  status = 200,
  {
    responseHeaders = {},
    respond = true,
  }: { responseHeaders?: Record<string, string>; respond?: boolean } = {},
) {
  const exchanges: Exchange[] = [];
  vi.mocked(request).mockImplementation((...args: unknown[]) => {
    const settings = args[1] as { headers: Record<string, string> };
    const callback = args[2] as (response: Exchange["response"]) => void;
    const response = Object.assign(new PassThrough(), {
      statusCode: status,
      headers: responseHeaders,
      complete: false,
    });
    const req = Object.assign(new EventEmitter(), {
      end: vi.fn((body: string) => {
        const exchange = { body, headers: settings.headers, response, req };
        exchanges.push(exchange);
        queueMicrotask(() => {
          // respond: false models a request whose response headers never arrive.
          if (respond) callback(response);
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

// The agent module loads asynchronously; start fake clocks once a request exists.
async function requested() {
  while (!vi.mocked(request).mock.calls.length)
    await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("webhook callback verification", () => {
  it("sends a signed single-use challenge with the subscription routing header", async () => {
    const exchanges = receiver(echo);
    await expect(verifyWebhookEndpoint(target(), context())).resolves.toEqual({
      verified: true,
    });
    await expect(verifyWebhookEndpoint(target(), context())).resolves.toEqual({
      verified: true,
    });
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
    await expect(verifyWebhookEndpoint(target(), context())).resolves.toEqual({
      verified: false,
      reason: "challenge_failed",
    });
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
    await expect(verifyWebhookEndpoint(target(), context())).resolves.toEqual({
      verified: false,
      reason: "challenge_failed",
    });
  });

  it.each([302, 401, 503])(
    "returns safe categories for HTTP %s without endpoint content",
    async (status) => {
      receiver(
        (exchange) => acknowledge(exchange, "sensitive endpoint response"),
        status,
      );
      await expect(verifyWebhookEndpoint(target(), context())).resolves.toEqual(
        {
          verified: false,
          reason:
            status === 302
              ? "challenge_failed"
              : status === 401
              ? "http_4xx"
              : "http_5xx",
        },
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});

describe("single-attempt event delivery", () => {
  it("validates the current policy, sends the wire envelope, and signs the exact UTF-8 bytes", async () => {
    const exchanges = receiver(acknowledge);
    const input = options();
    await expect(deliverWebhookEvent(input)).resolves.toEqual({
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
    await deliverWebhookEvent({
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
    await deliverWebhookEvent(input);
    vi.setSystemTime(Date.now() + 1_000);
    await deliverWebhookEvent(input);
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
      const result = await deliverWebhookEvent(options());
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
    await expect(deliverWebhookEvent(input)).resolves.toEqual({
      ok: false,
      reason: code,
      retryable: false,
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
    await expect(deliverWebhookEvent(input)).resolves.toEqual({
      ok: false,
      reason: "expired",
      retryable: false,
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
    await expect(deliverWebhookEvent(input)).rejects.toBe(error);
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
    await deliverWebhookEvent(input);
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
    await expect(deliverWebhookEvent(input)).resolves.toEqual({
      ok: true,
    });
  });

  it("omits undefined payload properties and preserves key order", async () => {
    const exchanges = receiver(acknowledge);
    const input = options();
    input.event.payloadSchema = z.strictObject({
      title: z.string(),
      id: z.string(),
      note: z.string().optional(),
    });
    input.payload = { title: "hello", id: "issue-1", note: undefined };
    await expect(deliverWebhookEvent(input)).resolves.toEqual({
      ok: true,
    });
    expect(exchanges[0].body).toContain(
      '"data":{"title":"hello","id":"issue-1"}',
    );
  });

  it("rejects oversized envelopes before policy checks or sending", async () => {
    receiver(acknowledge);
    const input = options();
    await expect(
      deliverWebhookEvent({
        ...input,
        payload: { id: "x", title: "x".repeat(256 * 1024) },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "payload_too_large",
      retryable: false,
    });
    expect(input.event.authorize).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a large body",
      ({ response }: Exchange) => response.write(Buffer.alloc(64 * 1024 + 1)),
    ],
    ["a truncated body", ({ response }: Exchange) => response.destroy()],
    ["a stalled body", () => {}],
  ])(
    "treats 2xx headers as the acknowledgement despite %s",
    async (_, handle) => {
      vi.useFakeTimers();
      const exchanges = receiver(handle);
      await expect(deliverWebhookEvent(options())).resolves.toEqual({
        ok: true,
      });
      expect(exchanges[0].response.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    [503, { "retry-after": "120" }, 120_000],
    [429, { "retry-after": "Wed, 07 Oct 2026 12:00:30 GMT" }, 30_000],
    [429, { "retry-after": "Wed, 07 Oct 2026 11:59:00 GMT" }, 0],
    [503, { "retry-after": "soon" }, undefined],
    [410, { "retry-after": "120" }, undefined],
  ])(
    "reports Retry-After on retryable failures: %s %o",
    async (status, responseHeaders, expected) => {
      vi.useFakeTimers({ now: new Date("2026-10-07T12:00:00Z") });
      receiver(acknowledge, status, { responseHeaders });
      const result = await deliverWebhookEvent(options());
      expect(result).toMatchObject({ ok: false, status });
      expect(result).toEqual(
        expected === undefined
          ? expect.not.objectContaining({ retryAfterMs: expect.anything() })
          : expect.objectContaining({ retryAfterMs: expected }),
      );
    },
  );
});

describe("webhook control notices", () => {
  const send = (
    control: WebhookControl,
    overrides: Partial<Parameters<typeof sendWebhookControl>[0]> = {},
  ) =>
    sendWebhookControl({
      subscription: target(),
      control,
      ...overrides,
    });

  it("signs gap notices with stable per-notice identifiers", async () => {
    vi.useFakeTimers();
    const exchanges = receiver(acknowledge);
    await expect(send({ type: "gap", cursor: "c1" })).resolves.toEqual({
      ok: true,
    });
    vi.setSystemTime(Date.now() + 1_000);
    await send({ type: "gap", cursor: "c1" });
    await send({ type: "gap", cursor: "c2" });
    const [first, retry, next] = exchanges;
    expect(new Webhook(secret).verify(first.body, first.headers)).toEqual({
      type: "gap",
      cursor: "c1",
    });
    expect(first.headers["webhook-id"]).toMatch(/^msg_gap_[0-9a-f]{32}$/);
    expect(first.headers["x-mcp-subscription-id"]).toBe("sub_test");
    expect(retry.headers["webhook-id"]).toBe(first.headers["webhook-id"]);
    expect(retry.headers["webhook-signature"]).not.toBe(
      first.headers["webhook-signature"],
    );
    expect(next.headers["webhook-id"]).not.toBe(first.headers["webhook-id"]);
  });

  it("sends termination notices without running event policies", async () => {
    const exchanges = receiver(acknowledge);
    const control = {
      type: "terminated",
      error: {
        code: -32012,
        message: "Forbidden",
        data: { reason: "revoked" },
      },
      extra: "not sent",
    } as WebhookControl;
    await expect(
      send(control, { previousSecrets: [oldSecret] }),
    ).resolves.toEqual({ ok: true });
    const { body, headers } = exchanges[0];
    const expected = {
      type: "terminated",
      error: {
        code: -32012,
        message: "Forbidden",
        data: { reason: "revoked" },
      },
    };
    expect(new Webhook(secret).verify(body, headers)).toEqual(expected);
    expect(new Webhook(oldSecret).verify(body, headers)).toEqual(expected);
    expect(headers["webhook-id"]).toMatch(/^msg_terminated_[0-9a-f]{32}$/);
  });

  it.each([
    { type: "gap", cursor: "" },
    { type: "gap" },
    { type: "terminated", error: { code: 1.5, message: "x" } },
    { type: "terminated", error: { code: 1, message: "x", data: new Date() } },
    { type: "verification", challenge: "x" },
  ])("rejects malformed notices before sending: %o", async (control) => {
    receiver(acknowledge);
    await expect(send(control as WebhookControl)).rejects.toThrow(TypeError);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an invalid stored subscription without sending", async () => {
    receiver(acknowledge);
    await expect(
      send(
        { type: "gap", cursor: "c1" },
        { subscription: { ...target(), url: "http://receiver.example/hooks" } },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_subscription",
      retryable: false,
    });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("bounded outbound transport", () => {
  it.each(["development", "test", "production"])(
    "uses the private filtering agent in %s",
    async (environment) => {
      vi.stubEnv("NODE_ENV", environment);
      receiver(acknowledge);
      await deliverWebhookEvent(options());
      const settings = vi.mocked(request).mock.calls[0][1] as {
        agent: { keepAlive: boolean; constructor: { name: string } };
      };
      expect(settings.agent.constructor.name).toBe(
        "RequestFilteringHttpsAgent",
      );
      expect(settings.agent.keepAlive).toBe(false);
    },
  );

  it("passes an explicit allowlist to a per-attempt filtering agent", async () => {
    receiver(acknowledge);
    const network = { allowIPAddressList: ["10.0.0.0/8", "::1"] };
    await deliverWebhookEvent({ ...options(), network });
    await deliverWebhookEvent(options());
    const [allowed, defaults] = vi.mocked(request).mock.calls.map(
      (call) =>
        (
          call[1] as {
            agent: { requestFilterOptions: { allowIPAddressList: string[] } };
          }
        ).agent,
    );
    expect(allowed).not.toBe(defaults);
    expect(allowed.requestFilterOptions.allowIPAddressList).toEqual([
      "10.0.0.0/8",
      "::1",
    ]);
    expect(defaults.requestFilterOptions.allowIPAddressList).toEqual([]);
  });

  it.each([
    { allowIPAddressList: ["localhost"] },
    { allowIPAddressList: ["10.0.0.0/33"] },
    { allowIPAddressList: ["10.0.0.0/8/8"] },
    { allowIPAddressList: "10.0.0.1" },
    { timeoutMs: 0 },
    { timeoutMs: 1.5 },
  ])(
    "rejects invalid network options before requesting: %o",
    async (network) => {
      receiver(acknowledge);
      const invalid = network as never;
      await expect(
        deliverWebhookEvent({ ...options(), network: invalid }),
      ).rejects.toThrow(TypeError);
      await expect(
        verifyWebhookEndpoint(target(), context(), invalid),
      ).rejects.toThrow(TypeError);
      expect(request).not.toHaveBeenCalled();
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
      verifyWebhookEndpoint(subscription, context()),
    ).rejects.toThrow(TypeError);
    await expect(
      deliverWebhookEvent({ ...options(), subscription }),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_subscription",
      retryable: false,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["", "not-a-secret", "whsec_aA=="])(
    "rejects invalid secrets before sending: %s",
    async (key) => {
      receiver(acknowledge);
      await expect(
        deliverWebhookEvent({ ...options(), previousSecrets: [key] }),
      ).resolves.toEqual({
        ok: false,
        reason: "invalid_subscription",
        retryable: false,
      });
      await expect(
        verifyWebhookEndpoint({ ...target(), secret: key }, context()),
      ).rejects.toThrow(TypeError);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("limits rotation to two previous secrets", async () => {
    receiver(acknowledge);
    await expect(
      deliverWebhookEvent({
        ...options(),
        previousSecrets: [oldSecret, oldSecret, oldSecret],
      }),
    ).rejects.toThrow("At most two previous secrets");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects identifiers that cannot be safely sent as headers", async () => {
    receiver(acknowledge);
    await expect(
      deliverWebhookEvent({ ...options(), eventId: "bad\r\nid" }),
    ).rejects.toThrow("Invalid webhook identifier");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["ECONNRESET", "ENOTFOUND", "CERT_HAS_EXPIRED"])(
    "returns safe transport failures for %s",
    async (code) => {
      receiver(
        ({ req }) =>
          req.emit(
            "error",
            Object.assign(new Error("sensitive endpoint details"), { code }),
          ),
        200,
        { respond: false },
      );
      await expect(deliverWebhookEvent(options())).resolves.toEqual({
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
    await expect(verifyWebhookEndpoint(target(), context())).resolves.toEqual({
      verified: false,
      reason: "challenge_failed",
    });
    expect(exchanges[0].response.destroyed).toBe(true);
  });

  it("treats a truncated challenge response as a transport failure", async () => {
    receiver(({ response }) => response.destroy());
    await expect(verifyWebhookEndpoint(target(), context())).resolves.toEqual({
      verified: false,
      reason: "connection_refused",
    });
  });

  it("bounds stalled challenge bodies by a total deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const exchanges = receiver(() => {});
    const result = verifyWebhookEndpoint(target(), context());
    await requested();
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(result).resolves.toEqual({
      verified: false,
      reason: "timeout",
    });
    expect(exchanges[0].req.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds deliveries without response headers by the configured deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const exchanges = receiver(() => {}, 200, { respond: false });
    const result = deliverWebhookEvent({
      ...options(),
      network: { timeoutMs: 500 },
    });
    await requested();
    await vi.advanceTimersByTimeAsync(499);
    expect(exchanges[0].req.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
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
    const exchanges = receiver(() => abort.abort(reason), 200, {
      respond: false,
    });
    await expect(
      deliverWebhookEvent({ ...options(), signal: abort.signal }),
    ).rejects.toBe(reason);
    expect(exchanges[0].req.destroy).toHaveBeenCalled();
  });

  it("does not dispatch with an already-aborted signal", async () => {
    receiver(acknowledge);
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(deliverWebhookEvent({ ...options(), signal })).rejects.toThrow(
      "cancelled",
    );
    await expect(
      verifyWebhookEndpoint(target(), context(signal)),
    ).rejects.toThrow("cancelled");
    expect(request).not.toHaveBeenCalled();
  });
});
