import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ExperimentalMcpEventDeliveryError,
  experimental_validateMcpEventDelivery,
  type ExperimentalMcpEventAuthorizationContext,
  type ExperimentalMcpEventDefinition,
  type ExperimentalMcpEventDeliveryValidationOptions,
} from "../src/index";

function setup() {
  const authorize = vi.fn(
    async (
      _args: Record<string, unknown>,
      _context: ExperimentalMcpEventAuthorizationContext,
    ) => true,
  );
  const event: ExperimentalMcpEventDefinition = {
    name: "issue.created",
    inputSchema: z.strictObject({ project: z.string() }),
    payloadSchema: z.strictObject({ id: z.string(), title: z.string() }),
    authorize,
  };
  // A projection of trusted state: no token, URL or signing secret is needed.
  const subscription = {
    principal: "tenant:acme:user:alice",
    name: "issue.created",
    arguments: { project: "ABC" },
    refreshBefore: new Date(Date.now() + 60_000).toISOString() as string | null,
  };
  const payload = { id: "issue-1", title: "A new issue" };
  const send = vi.fn();
  const validate = (
    overrides: Partial<ExperimentalMcpEventDeliveryValidationOptions> = {},
  ) =>
    experimental_validateMcpEventDelivery({
      event,
      subscription,
      payload,
      ...overrides,
    });
  const deliver = async (
    overrides: Partial<ExperimentalMcpEventDeliveryValidationOptions> = {},
  ) => {
    await validate(overrides);
    await send({ subscription, payload });
  };
  return { event, authorize, subscription, payload, send, validate, deliver };
}

afterEach(() => vi.useRealTimers());

describe("experimental_validateMcpEventDelivery", () => {
  it("authorizes stored identity without request credentials before sending unchanged data", async () => {
    const app = setup();
    const controller = new AbortController();
    const before = JSON.stringify({
      subscription: app.subscription,
      payload: app.payload,
    });
    await app.deliver({ signal: controller.signal });
    expect(app.authorize).toHaveBeenCalledWith(
      { project: "ABC" },
      {
        principal: "tenant:acme:user:alice",
        signal: controller.signal,
      },
    );
    expect(app.authorize.mock.calls[0][1]).not.toHaveProperty("authInfo");
    expect(app.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      app.send.mock.invocationCallOrder[0],
    );
    expect(app.send).toHaveBeenCalledWith({
      subscription: app.subscription,
      payload: app.payload,
    });
    expect(
      JSON.stringify({ subscription: app.subscription, payload: app.payload }),
    ).toBe(before);
  });

  it("accepts no-expiry subscriptions and still checks current permissions", async () => {
    const app = setup();
    app.subscription.refreshBefore = null;
    await app.deliver();
    expect(app.authorize).toHaveBeenCalledOnce();
    expect(app.send).toHaveBeenCalledOnce();
  });

  it.each([null, undefined])(
    "does not deliver for a missing subscription (%s)",
    async (subscription) => {
      const app = setup();
      await expect(app.deliver({ subscription })).rejects.toMatchObject({
        code: "invalid_subscription",
      });
      expect(app.authorize).not.toHaveBeenCalled();
      expect(app.send).not.toHaveBeenCalled();
    },
  );

  it.each([
    { principal: " " },
    { name: "" },
    { arguments: null },
    { arguments: [] },
    { refreshBefore: "invalid" },
    { refreshBefore: undefined },
    { refreshBefore: Date.now() + 60_000 },
  ])("fails closed for invalid stored state %j", async (patch) => {
    const app = setup();
    Object.assign(app.subscription, patch);
    await expect(app.deliver()).rejects.toMatchObject({
      code: "invalid_subscription",
    });
    expect(app.authorize).not.toHaveBeenCalled();
    expect(app.send).not.toHaveBeenCalled();
  });

  it("rejects a definition for another event before invoking its policy", async () => {
    const app = setup();
    app.event.name = "issue.deleted";
    await expect(app.deliver()).rejects.toMatchObject({
      code: "event_mismatch",
    });
    expect(app.authorize).not.toHaveBeenCalled();
    expect(app.send).not.toHaveBeenCalled();
  });

  it.each([-1, 0])(
    "rejects expiry at or before dispatch (%s ms)",
    async (offset) => {
      vi.useFakeTimers();
      const app = setup();
      app.subscription.refreshBefore = new Date(
        Date.now() + offset,
      ).toISOString();
      await expect(app.deliver()).rejects.toMatchObject({ code: "expired" });
      expect(app.authorize).not.toHaveBeenCalled();
      expect(app.send).not.toHaveBeenCalled();
    },
  );

  it("checks expiry again after asynchronous authorization", async () => {
    vi.useFakeTimers();
    const app = setup();
    app.authorize.mockImplementation(async () => {
      vi.setSystemTime(Date.parse(app.subscription.refreshBefore!));
      return true;
    });
    await expect(app.deliver()).rejects.toMatchObject({ code: "expired" });
    expect(app.send).not.toHaveBeenCalled();
  });

  it("stops before authorization if schema validation outlives the subscription", async () => {
    vi.useFakeTimers();
    const app = setup();
    app.event.payloadSchema = z.unknown().superRefine(async () => {
      vi.setSystemTime(Date.parse(app.subscription.refreshBefore!));
    });
    await expect(app.deliver()).rejects.toMatchObject({ code: "expired" });
    expect(app.authorize).not.toHaveBeenCalled();
    expect(app.send).not.toHaveBeenCalled();
  });

  it("checks stored arguments against the current schema", async () => {
    const app = setup();
    app.event.inputSchema = z.strictObject({
      project: z.string(),
      workspace: z.string(),
    });
    await expect(app.deliver()).rejects.toMatchObject({
      code: "invalid_arguments",
    });
    expect(app.authorize).not.toHaveBeenCalled();
    expect(app.send).not.toHaveBeenCalled();
  });

  it("rejects argument transformations instead of changing the authorized filters", async () => {
    const app = setup();
    app.event.inputSchema = z.object({ project: z.string().toLowerCase() });
    await expect(app.deliver()).rejects.toMatchObject({
      code: "invalid_arguments",
    });
    expect(app.authorize).not.toHaveBeenCalled();
    expect(app.subscription.arguments).toEqual({ project: "ABC" });
  });

  it("rejects invalid data without reflecting payloads or schema issues", async () => {
    const app = setup();
    const result = app.deliver({ payload: { id: 123, title: "private-data" } });
    await expect(result).rejects.toBeInstanceOf(
      ExperimentalMcpEventDeliveryError,
    );
    await expect(result).rejects.toMatchObject({
      code: "invalid_payload",
      message: "Payload must be JSON matching the event schema unchanged",
    });
    expect(app.send).not.toHaveBeenCalled();
  });

  it.each([
    z.object({ id: z.string() }),
    z.object({ id: z.string(), title: z.string().toUpperCase() }),
    z.object({
      id: z.string(),
      title: z.string(),
      version: z.number().default(1),
    }),
  ])(
    "rejects payload stripping, transformations and defaults (%#)",
    async (payloadSchema) => {
      const app = setup();
      app.event.payloadSchema = payloadSchema;
      await expect(app.deliver()).rejects.toMatchObject({
        code: "invalid_payload",
      });
      expect(app.authorize).not.toHaveBeenCalled();
      expect(app.send).not.toHaveBeenCalled();
    },
  );

  it("rejects schema mutation of the original payload", async () => {
    const app = setup();
    app.event.payloadSchema = z.unknown().transform((value) => {
      (value as { title: string }).title = "mutated";
      return value;
    });
    await expect(app.deliver()).rejects.toMatchObject({
      code: "invalid_payload",
    });
    expect(app.send).not.toHaveBeenCalled();
  });

  it("allows equivalent object key ordering without rewriting the payload", async () => {
    const app = setup();
    app.event.payloadSchema = z.object({ title: z.string(), id: z.string() });
    await app.deliver();
    expect(app.send).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    NaN,
    Infinity,
    BigInt(1),
    new Date(),
    { field: undefined },
    [undefined],
  ])(
    "rejects non-JSON payloads even with a permissive schema (%#)",
    async (payload) => {
      const app = setup();
      app.event.payloadSchema = z.unknown();
      await expect(app.deliver({ payload })).rejects.toMatchObject({
        code: "invalid_payload",
      });
      expect(app.send).not.toHaveBeenCalled();
    },
  );

  it("rejects cyclic JSON but permits shared subobjects", async () => {
    const app = setup();
    app.event.payloadSchema = z.unknown();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(app.validate({ payload: cyclic })).rejects.toMatchObject({
      code: "invalid_payload",
    });
    const shared = { value: 1 };
    await expect(
      app.validate({ payload: { a: shared, b: shared } }),
    ).resolves.toBeUndefined();
  });

  it.each([false, undefined, "true"])(
    "requires explicit permission, not truthiness (%s)",
    async (allowed) => {
      const app = setup();
      app.authorize.mockResolvedValue(allowed as boolean);
      await expect(app.deliver()).rejects.toMatchObject({ code: "forbidden" });
      expect(app.send).not.toHaveBeenCalled();
    },
  );

  it("rechecks permissions for each attempt instead of caching an earlier grant", async () => {
    const app = setup();
    await app.deliver();
    app.authorize.mockResolvedValue(false);
    await expect(app.deliver()).rejects.toMatchObject({ code: "forbidden" });
    expect(app.authorize).toHaveBeenCalledTimes(2);
    expect(app.send).toHaveBeenCalledOnce();
  });

  it("propagates policy outages so they are not mistaken for revoked permission", async () => {
    const app = setup();
    const outage = new Error("Permissions service unavailable");
    app.authorize.mockRejectedValue(outage);
    await expect(app.deliver()).rejects.toBe(outage);
    expect(app.send).not.toHaveBeenCalled();
  });

  it("propagates schema exceptions without sending", async () => {
    const app = setup();
    const outage = new Error("Schema backend unavailable");
    app.event.payloadSchema = z.unknown().superRefine(() => {
      throw outage;
    });
    await expect(app.deliver()).rejects.toBe(outage);
    expect(app.send).not.toHaveBeenCalled();
  });

  it("honors worker cancellation before and during validation", async () => {
    const app = setup();
    const before = new AbortController();
    const reason = new Error("Job cancelled");
    before.abort(reason);
    await expect(app.deliver({ signal: before.signal })).rejects.toBe(reason);
    expect(app.authorize).not.toHaveBeenCalled();
    const during = new AbortController();
    app.authorize.mockImplementation(async (_args, { signal }) => {
      expect(signal).toBe(during.signal);
      during.abort(reason);
      return true;
    });
    await expect(app.deliver({ signal: during.signal })).rejects.toBe(reason);
    expect(app.send).not.toHaveBeenCalled();
  });
});
