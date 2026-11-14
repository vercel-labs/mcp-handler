---
"mcp-handler": patch
---

Record a request whose connection closes before the answer as `cancelled`, not an `execution_failure`, including when the client cancels the response stream without aborting the request. A store that returns no subscription operation now fails the `prepare` span instead of recording it as prepared.
