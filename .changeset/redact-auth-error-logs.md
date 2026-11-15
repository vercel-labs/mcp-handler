---
"mcp-handler": patch
---

Log only the error name when `verifyToken` throws an unexpected error, so driver or identity provider details don't reach platform logs. Set `logAuthErrors: "full"` to keep the previous output or `"none"` to turn it off.
