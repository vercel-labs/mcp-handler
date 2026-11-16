---
"mcp-handler": patch
---

Log only the error name when `verifyToken` throws an unexpected error, so driver or identity provider details don't reach platform logs. Set `logAuthErrors: "full"` to keep the previous output or `"none"` to turn it off. The same applies to an unexpected error after verification, which `withMcpAuth` answers with a 500.
