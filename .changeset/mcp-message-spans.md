---
"mcp-handler": minor
---

Write one OpenTelemetry `SERVER` span per MCP request or notification, following the OpenTelemetry MCP semantic conventions and the `vercel.rpc.*` attributes Vercel's MCP observability reads. Spans are written only when the app registers a tracer provider; `mcp-handler` has no runtime dependency on `@opentelemetry/api`. Set the endpoint label with `telemetry.route`, or turn spans off with `telemetry: false`.

Add `registerMcpOTel()` in `mcp-handler/otel`, which registers `@vercel/otel` 2.x with the Vercel project as the service name and removes the raw `User-Agent` and `Referer` attributes `@vercel/otel` adds to spans.

With MCP Events, write `mcp.event.subscription {action}` and `mcp.event.verify_callback` spans around the calls to the application's subscription store and `verifyEndpoint`.

Spans are on by default whenever the app registers a tracer provider. If your app already writes its own MCP `SERVER` spans with `mcp.method.name`, or `mcp.event.*` spans around its MCP Events store or `verifyEndpoint`, set `telemetry: false` or remove your spans when upgrading, or each message and subscription step is recorded twice.
