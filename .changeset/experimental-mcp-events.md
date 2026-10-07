---
"mcp-handler": minor
---

Add `experimental_registerMcpEvents` for the draft MCP Events webhook control methods, with authenticated catalogs, event argument validation, deterministic subscription identity, and application-owned storage and delivery adapters. Require a bounded subscription reservation before callback verification and pass its fencing token into activation so adapters can prevent late verification from undoing cancellation or newer refreshes. Redact webhook signing secrets from request telemetry.

Add `experimental_validateMcpEventDelivery` for workers to check subscription expiry, validate event data without transformations, and recheck authorization using stored identity without retaining access tokens.

Allow event definitions to provide `authorizeDiscovery` to filter authenticated catalogs and subscription lookup, while keeping authorization of actual subscription arguments separate.
