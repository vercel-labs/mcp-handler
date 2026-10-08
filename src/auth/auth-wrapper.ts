import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
} from "@modelcontextprotocol/server";
import { getPublicOrigin } from "../lib/url";

declare global {
  interface Request {
    auth?: AuthInfo;
  }
}

export function withMcpAuth(
  handler: (req: Request) => Response | Promise<Response>,
  verifyToken: (
    req: Request,
    bearerToken?: string,
  ) => AuthInfo | undefined | Promise<AuthInfo | undefined>,
  {
    required = false,
    resourceMetadataPath = "/.well-known/oauth-protected-resource",
    requiredScopes,
    resourceUrl,
  }: {
    required?: boolean;
    resourceMetadataPath?: string;
    requiredScopes?: string[];
    /**
     * Explicit resource URL override. When provided, this URL is used as the
     * origin for constructing the resource_metadata URL. Use this when running
     * behind a proxy that doesn't set standard forwarding headers, or when you
     * need to specify a specific public URL.
     *
     * If not provided, the origin is automatically detected from proxy headers
     * (X-Forwarded-Host, X-Forwarded-Proto, Forwarded) or falls back to req.url.
     */
    resourceUrl?: string;
  } = {},
) {
  return async (req: Request) => {
    const origin = resourceUrl ?? getPublicOrigin(req);
    const resourceMetadataUrl = `${origin}${resourceMetadataPath}`;
    const challengeOptions = { requiredScopes, resourceMetadataUrl };

    const authHeader = req.headers.get("Authorization");
    const [type, token] = authHeader?.split(" ") || [];

    // Only support bearer token as per the MCP spec
    // https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization#2-6-1-token-requirements
    const bearerToken = type?.toLowerCase() === "bearer" ? token : undefined;

    let authInfo: AuthInfo | undefined;
    try {
      authInfo = await verifyToken(req, bearerToken);
    } catch (error) {
      console.error("Unexpected error authenticating bearer token:", error);
      return bearerAuthChallengeResponse(
        new OAuthError(OAuthErrorCode.InvalidToken, "Invalid token"),
        challengeOptions,
      );
    }

    try {
      if (required && !authInfo) {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "No authorization provided",
        );
      }

      if (!authInfo) {
        return handler(req);
      }

      // Check if the token is expired before authorizing it. An expired token
      // is invalid_token (401) per RFC 6750 §3.1, so it has to be reported that
      // way even when scopes are also missing: insufficient_scope (403) tells
      // the client its permissions are wrong and it will not refresh.
      if (authInfo.expiresAt && authInfo.expiresAt < Date.now() / 1000) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Token has expired");
      }

      // Check if token has the required scopes (if any)
      if (requiredScopes?.length) {
        const hasAllScopes = requiredScopes.every((scope) =>
          authInfo!.scopes.includes(scope),
        );

        if (!hasAllScopes) {
          throw new OAuthError(
            OAuthErrorCode.InsufficientScope,
            "Insufficient scope",
          );
        }
      }

      // Set auth info on the request object after successful verification
      req.auth = authInfo;

      return handler(req);
    } catch (error) {
      if (!OAuthError.isInstance(error)) {
        console.error("Unexpected error authenticating bearer token:", error);
      }
      // Maps invalid_token → 401, insufficient_scope → 403 (both with a
      // WWW-Authenticate challenge advertising resource_metadata), anything
      // unexpected → 500 server_error.
      return bearerAuthChallengeResponse(error, challengeOptions);
    }
  };
}
