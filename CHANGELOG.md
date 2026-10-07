# mcp-handler

## 2.3.0

### Minor Changes

- 0073647: Add `experimental_registerMcpEvents` for the draft MCP Events webhook control methods, with authenticated catalogs, event argument validation, deterministic subscription identity, and application-owned storage and delivery adapters. Require a bounded subscription reservation before callback verification and pass its fencing token into activation so adapters can prevent late verification from undoing cancellation or newer refreshes. Redact webhook signing secrets from request telemetry.

  Add `experimental_validateMcpEventDelivery` for workers to check subscription expiry, validate event data without transformations, and recheck authorization using stored identity without retaining access tokens.

  Allow event definitions to provide `authorizeDiscovery` to filter authenticated catalogs and subscription lookup, while keeping authorization of actual subscription arguments separate.

### Patch Changes

- fb83ab8: Fix release workflow authentication by using GitHub's built-in token instead of a fine-grained personal access token.

## 2.2.0

### Minor Changes

- 79aa420: Promote the experimental WebMCP bridge to a minor release.

## 2.1.2

### Patch Changes

- f37e63e: Add an experimental `experimental_webMcp` option to `createMcpHandler`, which serves a browser bridge from the existing MCP route and registers an explicit allowlist of the endpoint's tools with the page's WebMCP provider (`navigator.modelContext` / `document.modelContext`).

## 2.1.1

### Patch Changes

- e38a932: Forward `maxSubscriptions` to the MCP SDK handler so applications can bound or disable subscription streams.

## 2.1.0

### Minor Changes

- 8398dbd: `createMcpHandler(initialize, serverOptions, config)` is now `createMcpHandler(initialize, options)` — a single options object combining the SDK's `ServerOptions` with `serverInfo`, `verboseLogs`, and `onEvent` (exported as `McpHandlerOptions`). The deprecated 1.x compatibility shims (`basePath`, `streamableHttpEndpoint`, `sseEndpoint`, `sseMessageEndpoint`, `disableSse`, `redisUrl`, `maxDuration`, `sessionIdGenerator`) are removed.

## 2.0.1

### Patch Changes

- e6e6378: Mount the MCP handler directly at a framework route and remove legacy transport endpoint routing. The CLI now generates `app/api/mcp/route.ts`; deprecated route, SSE, Redis, and session config keys remain accepted as ignored 2.x compatibility shims.

## 2.0.0

### Major Changes

- 33c06b6: Upgrade to MCP SDK v2 and the 2026-07-28 MCP specification (CIMD era).

  - The handler now serves the stateless 2026-07-28 protocol (per-request `_meta` envelope, `server/discover`) natively, with the SDK's stateless legacy fallback answering 2025-era Streamable HTTP clients from the same handler.
  - **Breaking**: requires `@modelcontextprotocol/server` ^2.0.0 (replaces the `@modelcontextprotocol/sdk` peer dependency), `zod` ^4.2.0 for schemas, and Node.js 20+.
  - **Breaking**: the legacy HTTP+SSE transport (protocol 2024-11-05) has been removed. `/sse` and `/message` endpoints answer `410 Gone`; the `redis` dependency and `redisUrl`, `maxDuration`, and `sessionIdGenerator` config options are deprecated no-ops.
  - **Breaking**: tool/prompt/resource registration follows SDK v2 (`registerTool` with `z.object(...)` Standard Schemas; variadic `server.tool(...)` is gone; `extra.authInfo` is now `ctx.http?.authInfo`).
  - `withMcpAuth` now builds its 401/403 challenges with the SDK's consolidated `OAuthError`/`bearerAuthChallengeResponse`, keeping RFC 9728 `resource_metadata` discovery in place for CIMD-era authorization flows. Dynamic Client Registration is deprecated by the spec in favor of Client ID Metadata Documents — see README.

## 1.1.0

### Minor Changes

- 7ac97dc: Require minimum of @modelcontextprotocol/sdk@1.26.0 which uses web streams

## 1.0.7

### Patch Changes

- 5a92040: Update pinned version of MCP TS SDK to 1.25.2 for vulnerability patch
- 8c51d39: Allow passing in sessionIdGenerator for stateful sessions

## 1.0.6

### Patch Changes

- a9c7af5: Ensure auth profiles stay tied to the request

## 1.0.5

### Patch Changes

- 81bdf1c: Update README, examples, and support for > MCP TS SDK 1.25.0
- 6e75141: Add raw headers to incoming message
- 51b8a24: bump @modelcontextprotocol/sdk version

## 1.0.4

### Patch Changes

- 1.0.4: update dependencies to use version 1.22.0 of @modelcontextprotocol/sdk

## 1.0.3

### Patch Changes

- 639e634: update oauth usage

## 1.0.2

### Patch Changes

- 956dc11: Fix memory leak when using SSE connections

## 1.0.1

### Patch Changes

- d829aa6: prm resource identifier calculation accounts for paths

## 1.0.0

### Major Changes

- 201a1c7: Move package from @vercle/mcp-adapter to mcp-handler

### Minor Changes

- 488dfe4: Refactor packaging and make withMcpAuth stable
- 02df830: Add RFC 9728 OAuth Protected Resource Metadata handler

## 0.11.2

### Patch Changes

- c5c4ba5: chore: correctly resolve esm types

## 0.11.1

### Patch Changes

- fc2a6d8: Update README during NPM outage

## 0.11.0

### Minor Changes

- 7149159: Support adding serverMetadata to name and version the mcp server

## 0.10.0

### Minor Changes

- 71c14ea: Fix import error with mcp sdk

### Patch Changes

- 71c14ea: Fix module resolution

## 0.9.1

### Patch Changes

- c86da9a: Not optional

## 0.9.0

### Minor Changes

- 58efcf0: Add peerDependenciesMeta to fix not packaging the MCP SDK anymore

## 0.8.2

### Patch Changes

- 15fded0: Fix mjs module resolution

## 0.8.1

### Patch Changes

- 83e6fc7: Move zod to DevDep
- 12b61fd: Add more robust error handling to auth logic
- a522ffd: Move zod to devDep

## 0.8.0

### Minor Changes

- 166e5ab: Add option to disable SSE as per MCP spec

### Patch Changes

- 62518f2: Fix timeout scoping bug causing ReferenceError in SSE Handler
- c55c609: Update auth logic to not throw error is missing bearerToken

## 0.7.3

### Patch Changes

- 8fd2538: Fix missing non async argument

## 0.7.2

### Patch Changes

- 47eff5a: Fix allowing both async and non async handlers

## 0.7.1

### Patch Changes

- 13bd4fa: Add in auth handler

## 0.7.0

### Minor Changes

- b24064f: Update pinned mcp sdk version to 1.12.0

## 0.6.2

### Patch Changes

- 4f7a593: Fix SSE initializeServer

## 0.6.1

### Patch Changes

- b46856a: Allow an async initializeServer call

## 0.6.0

### Minor Changes

- 74d8a2c: Fix backwards compatibility algorithm with HTTP + SSE

## 0.5.1

### Patch Changes

- f48b5d6: Fix HTTP status code for some errors

## 0.5.0

### Minor Changes

- 24ce36e: added cli support to auto add the mcp route to a nextjs project

### Patch Changes

- 24ce36e: updated readme
- 48d4d64: fix out of date pnpm lock

## 0.4.1

### Patch Changes

- c0d7675: add logging

## 0.4.0

### Minor Changes

- 7fe14e6: make redis optional by only init on sse and messages

### Patch Changes

- 99d7837: fix release

## 0.2.4

### Patch Changes

- update readme with consistent docs ([#13309](https://github.com/vercel/vercel/pull/13309))

- Fix message endpoint not being settable ([#13311](https://github.com/vercel/vercel/pull/13311))

## 0.2.3

### Patch Changes

- Update readme and example ([#13307](https://github.com/vercel/vercel/pull/13307))

## 0.2.2

### Patch Changes

- Correct file output ([#13305](https://github.com/vercel/vercel/pull/13305))

## 0.2.1

### Patch Changes

- add in repository to readme and fix up example ([#13298](https://github.com/vercel/vercel/pull/13298))

## 0.2.0

### Minor Changes

- Publish initial version of mcp adapter ([#13290](https://github.com/vercel/vercel/pull/13290))

### Patch Changes

- make package public and fix default args passed in ([#13294](https://github.com/vercel/vercel/pull/13294))
