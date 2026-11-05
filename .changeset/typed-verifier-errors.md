---
"mcp-handler": patch
---

Respect an `OAuthError` thrown by `verifyToken` in `withMcpAuth`: the response now uses its own code and status (for example `403 insufficient_scope` or `500 server_error`) and the error is no longer logged. Untyped errors are still logged and answered with `401 invalid_token`.
