---
"mcp-handler": minor
---

Add an opt-in `cors` option to `createMcpHandler` and `withMcpAuth` for browser-based MCP clients on other origins. With it set, `OPTIONS` preflights get `204` with the allowed methods and headers, and every response carries `Access-Control-Allow-Origin` (any origin or an allow-list) and exposes `mcp-session-id`, `mcp-protocol-version` and `www-authenticate`. Off by default, so existing handlers are unchanged.
