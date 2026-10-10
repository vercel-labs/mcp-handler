import type { ExperimentalMcpEventAuthorizationContext } from "../types";

/** @experimental The Vercel Connect subject whose token `authorize` uses. */
export type ConnectAuthorizeSubject =
  | {
      type: "user";
      id: string;
      issuer?: string;
      /**
       * Resolve the user through this identity-provider connector with
       * Cross-App Access (ID-JAG), so users who signed in with your IdP need
       * no separate consent per connector. Experimental in @vercel/connect.
       */
      experimental_idp?: string;
    }
  | { type: "app" };

/** @experimental Options for `connect`. */
export interface ConnectAuthorizeOptions {
  /**
   * Map the events principal to a Connect subject.
   * @default (principal) => ({ type: "user", id: principal })
   */
  subject?(principal: string): ConnectAuthorizeSubject;
  /** Provider scopes to request. Connect's default scopes when omitted. */
  scopes?: string[];
}

type ConnectModule = typeof import("@vercel/connect");

// Lazy ESM import keeps @vercel/connect an optional peer and works from the
// package's CommonJS entry on Node 20.
let connectModule: Promise<ConnectModule> | undefined;
function loadConnect() {
  connectModule ??= import("@vercel/connect").catch((error) => {
    connectModule = undefined;
    throw new Error("connect requires the @vercel/connect package", {
      cause: error,
    });
  });
  return connectModule;
}

/**
 * Build an event `authorize` policy from the subscriber's Vercel Connect
 * token, so delivery-time checks need no stored access token.
 *
 * A missing or revoked grant (the user must re-authorize, no valid token, or
 * the connector is not installed) denies, which ends the subscription. Any
 * other Connect failure throws, so the delivery is retried instead.
 *
 * @experimental
 */
export function connect<Args>(
  connector: string,
  check: (
    token: string,
    args: Args,
    context: ExperimentalMcpEventAuthorizationContext,
  ) => boolean | Promise<boolean>,
  options: ConnectAuthorizeOptions = {},
): (
  args: Args,
  context: ExperimentalMcpEventAuthorizationContext,
) => Promise<boolean> {
  const subject =
    options.subject ?? ((id: string) => ({ type: "user" as const, id }));
  return async (args, context) => {
    const connect = await loadConnect();
    let token: string;
    try {
      token = await connect.getToken(connector, {
        subject: subject(context.principal),
        ...(options.scopes ? { scopes: options.scopes } : {}),
      });
    } catch (error) {
      if (
        error instanceof connect.UserAuthorizationRequiredError ||
        error instanceof connect.NoValidTokenError ||
        error instanceof connect.ConnectorInstallationRequiredError
      )
        return false;
      throw error;
    }
    context.signal.throwIfAborted();
    return (await check(token, args, context)) === true;
  };
}
