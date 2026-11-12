---
"mcp-handler": minor
---

Add `experimental_setToolOutcome(ctx, { outcome, errorType })`, which a tool handler calls to say why it failed. Its MCP span then records `api_error`, `tool_error`, `execution_failure` or `request_error` with a short `error.type` such as `forbidden` or `timeout`, instead of the default `execution_failure` / `internal_error`. It applies only to calls answered with an `isError` result.
