---
"mcp-handler": minor
---

Add an experimental MCP Events engine at `mcp-handler/events`. `defineEvent` and `createMcpEvents` handle subscription storage, callback verification with consent caching and rate limits, partitioned fan-out, Standard Webhooks-signed delivery with retries and `Retry-After`, secret rotation, expiry and revocation, on a store and queue you provide. Includes in-memory, Redis and Vercel Queues adapters, a store conformance check, `connect` for access checks with Vercel Connect tokens, and a `createMcpHandler` `events` option.

Events now follow draft SEP-3415 while staying compatible with ChatGPT: both capability shapes are advertised, and error codes and `terminated` notices follow the dialect each client declares per request (`chatgptCompat: false` serves SEP-3415 only).

The root entry keeps its 2.3.0 exports without Node.js-only dependencies, and its CommonJS type declarations now resolve.
