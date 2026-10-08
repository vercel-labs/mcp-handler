import { describe, it, expect, vi } from "vitest";
import { protectedResourceHandler, withMcpAuth } from "../src/index";

describe("auth", () => {
  describe("resource metadata URL to resource identifier mapping", () => {
    const handler = protectedResourceHandler({
      authServerUrls: ["https://auth-server.com"],
    });

    const testCases = [
      // Default well-known URI suffix (oauth-protected-resource)
      {
        resourceMetadata: 'https://resource-server.com/.well-known/oauth-protected-resource',
        resource: 'https://resource-server.com',
      },
      {
        resourceMetadata: 'https://resource-server.com/.well-known/oauth-protected-resource/my-resource',
        resource: 'https://resource-server.com/my-resource',
      },
      {
        resourceMetadata: 'https://resource-server.com/.well-known/oauth-protected-resource/foo/bar',
        resource: 'https://resource-server.com/foo/bar',
      },
      // Ensure ports work
      {
        resourceMetadata: 'https://resource-server.com:8443/.well-known/oauth-protected-resource',
        resource: 'https://resource-server.com:8443',
      },
      // Example well-known URI suffix from RFC 9728 (example-protected-resource)
      {
        resourceMetadata: 'https://resource-server.com/.well-known/example-protected-resource',
        resource: 'https://resource-server.com',
      },
      {
        resourceMetadata: 'https://resource-server.com/.well-known/example-protected-resource/my-resource',
        resource: 'https://resource-server.com/my-resource',
      },
    ] as const;

    testCases.forEach(testCase => {
      it(`${testCase.resourceMetadata} → ${testCase.resource}`, async () => {
        const req = new Request(testCase.resourceMetadata);
        const res = handler(req);
        const json = await res.json();
        expect(json.resource).toBe(testCase.resource);
      });
    });
  });

  describe("proxy header support", () => {
    const handler = protectedResourceHandler({
      authServerUrls: ["https://auth-server.com"],
    });

    it("uses X-Forwarded-Host and X-Forwarded-Proto headers", async () => {
      const req = new Request("http://localhost:3000/.well-known/oauth-protected-resource", {
        headers: {
          "X-Forwarded-Host": "example.org",
          "X-Forwarded-Proto": "https",
        },
      });
      const res = handler(req);
      const json = await res.json();
      expect(json.resource).toBe("https://example.org");
    });

    it("handles X-Forwarded-Host with multiple values (uses first)", async () => {
      const req = new Request("http://localhost:3000/.well-known/oauth-protected-resource", {
        headers: {
          "X-Forwarded-Host": "example.org, proxy1.internal, proxy2.internal",
          "X-Forwarded-Proto": "https",
        },
      });
      const res = handler(req);
      const json = await res.json();
      expect(json.resource).toBe("https://example.org");
    });

    it("defaults to https when X-Forwarded-Proto is missing", async () => {
      const req = new Request("http://localhost:3000/.well-known/oauth-protected-resource", {
        headers: {
          "X-Forwarded-Host": "example.org",
        },
      });
      const res = handler(req);
      const json = await res.json();
      expect(json.resource).toBe("https://example.org");
    });

    it("uses RFC 7239 Forwarded header", async () => {
      const req = new Request("http://localhost:3000/.well-known/oauth-protected-resource", {
        headers: {
          "Forwarded": "host=example.org;proto=https",
        },
      });
      const res = handler(req);
      const json = await res.json();
      expect(json.resource).toBe("https://example.org");
    });

    it("preserves path when using proxy headers", async () => {
      const req = new Request("http://localhost:3000/.well-known/oauth-protected-resource/my-resource", {
        headers: {
          "X-Forwarded-Host": "example.org",
          "X-Forwarded-Proto": "https",
        },
      });
      const res = handler(req);
      const json = await res.json();
      expect(json.resource).toBe("https://example.org/my-resource");
    });

    it("falls back to req.url when no proxy headers present", async () => {
      const req = new Request("https://direct-server.com/.well-known/oauth-protected-resource");
      const res = handler(req);
      const json = await res.json();
      expect(json.resource).toBe("https://direct-server.com");
    });
  });

  describe("explicit resourceUrl override", () => {
    it("uses explicit resourceUrl when provided", async () => {
      const handler = protectedResourceHandler({
        authServerUrls: ["https://auth-server.com"],
        resourceUrl: "https://my-public-domain.com",
      });

      const req = new Request("http://localhost:3000/.well-known/oauth-protected-resource", {
        headers: {
          "X-Forwarded-Host": "different-proxy.org",
          "X-Forwarded-Proto": "https",
        },
      });
      const res = handler(req);
      const json = await res.json();
      // Should use explicit override, ignoring both req.url and proxy headers
      expect(json.resource).toBe("https://my-public-domain.com");
    });
  });

  describe("withMcpAuth token expiry and scope checks", () => {
    const ok = () => new Response("ok");

    function buildHandler(requiredScopes?: string[]) {
      return withMcpAuth(ok, (_req, bearer) => {
        if (!bearer) return undefined;
        const [scopes, expiresAt] = bearer.split("|");
        return {
          token: bearer,
          clientId: "c1",
          scopes: scopes.split(","),
          expiresAt: expiresAt ? Number(expiresAt) : undefined,
        };
      }, { required: true, requiredScopes });
    }

    function request(token: string) {
      return new Request("https://example.com/mcp", {
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    it("returns 401 for an expired token even when scopes are missing", async () => {
      const handler = buildHandler(["admin"]);
      const expired = Math.floor(Date.now() / 1000) - 60;
      const res = await handler(request(`read|${expired}`));
      expect(res.status).toBe(401);
      const challenge = res.headers.get("WWW-Authenticate") ?? "";
      expect(challenge).toContain("invalid_token");
      expect(challenge).not.toContain("insufficient_scope");
    });

    it("returns 403 for a live token that lacks required scopes", async () => {
      const handler = buildHandler(["admin"]);
      const future = Math.floor(Date.now() / 1000) + 3600;
      const res = await handler(request(`read|${future}`));
      expect(res.status).toBe(403);
      const challenge = res.headers.get("WWW-Authenticate") ?? "";
      expect(challenge).toContain("insufficient_scope");
    });

    it("passes through when token is live and scopes match", async () => {
      const handler = buildHandler(["read"]);
      const future = Math.floor(Date.now() / 1000) + 3600;
      const res = await handler(request(`read|${future}`));
      expect(res.status).toBe(200);
    });

    it("returns 401 for an expired token with no required scopes", async () => {
      const handler = buildHandler();
      const expired = Math.floor(Date.now() / 1000) - 60;
      const res = await handler(request(`read|${expired}`));
      expect(res.status).toBe(401);
    });

    it("returns 401 when no authorization is provided and auth is required", async () => {
      const handler = buildHandler();
      const res = await handler(
        new Request("https://example.com/mcp"),
      );
      expect(res.status).toBe(401);
    });
  });
});

