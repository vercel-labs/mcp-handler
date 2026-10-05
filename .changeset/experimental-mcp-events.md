---
"mcp-handler": minor
---

Add `experimental_registerMcpEvents` for the draft MCP Events webhook control methods, with authenticated catalogs, event argument validation, deterministic subscription identity, and application-owned storage and delivery adapters. Redact webhook signing secrets from request telemetry.

Add `experimental_validateMcpEventDelivery` for workers to check subscription expiry, validate event data without transformations, and recheck authorization using stored identity without retaining access tokens.
