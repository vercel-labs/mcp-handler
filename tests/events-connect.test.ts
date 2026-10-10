import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectError,
  ConnectorInstallationRequiredError,
  NoValidTokenError,
  UserAuthorizationRequiredError,
  getToken,
} from "@vercel/connect";
import { connect } from "../src/events/index";

vi.mock("@vercel/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vercel/connect")>()),
  getToken: vi.fn(),
}));

const context = (signal = new AbortController().signal) => ({
  principal: "user_123",
  signal,
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("connect", () => {
  it("checks access with the principal's Connect token", async () => {
    vi.mocked(getToken).mockResolvedValue("tok");
    const check = vi.fn(
      async (token: string, args: { projectId: string }) =>
        token === "tok" && args.projectId === "p1",
    );
    const authorize = connect("linear/acme", check);
    const ctx = context();
    await expect(authorize({ projectId: "p1" }, ctx)).resolves.toBe(true);
    await expect(authorize({ projectId: "p2" }, ctx)).resolves.toBe(false);
    expect(getToken).toHaveBeenCalledWith("linear/acme", {
      subject: { type: "user", id: "user_123" },
    });
    expect(check).toHaveBeenCalledWith("tok", { projectId: "p1" }, ctx);
  });

  it("maps the subject and passes scopes", async () => {
    vi.mocked(getToken).mockResolvedValue("tok");
    const authorize = connect("linear/acme", () => true, {
      subject: (principal) => ({
        type: "user",
        id: principal.split(":")[1],
        issuer: "https://acme.okta.com",
        experimental_idp: "okta/acme",
      }),
      scopes: ["read"],
    });
    await authorize({}, { ...context(), principal: "tenant:alice" });
    expect(getToken).toHaveBeenCalledWith("linear/acme", {
      subject: {
        type: "user",
        id: "alice",
        issuer: "https://acme.okta.com",
        experimental_idp: "okta/acme",
      },
      scopes: ["read"],
    });
  });

  it("only accepts an explicit true from the check", async () => {
    vi.mocked(getToken).mockResolvedValue("tok");
    const authorize = connect("linear/acme", () => "yes" as never);
    await expect(authorize({}, context())).resolves.toBe(false);
  });

  it.each([
    UserAuthorizationRequiredError,
    NoValidTokenError,
    ConnectorInstallationRequiredError,
  ])("denies when the grant is gone (%s)", async (ErrorClass) => {
    vi.mocked(getToken).mockRejectedValue(new ErrorClass("no grant"));
    const check = vi.fn(() => true);
    const authorize = connect("linear/acme", check);
    await expect(authorize({}, context())).resolves.toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it.each([new ConnectError("unavailable"), new Error("network")])(
    "throws on other Connect failures so deliveries retry",
    async (error) => {
      vi.mocked(getToken).mockRejectedValue(error);
      const authorize = connect("linear/acme", () => true);
      await expect(authorize({}, context())).rejects.toBe(error);
    },
  );

  it("honors cancellation before running the check", async () => {
    const abort = new AbortController();
    vi.mocked(getToken).mockImplementation(async () => {
      abort.abort(new Error("cancelled"));
      return "tok";
    });
    const check = vi.fn(() => true);
    const authorize = connect("linear/acme", check);
    await expect(authorize({}, context(abort.signal))).rejects.toThrow(
      "cancelled",
    );
    expect(check).not.toHaveBeenCalled();
  });
});
