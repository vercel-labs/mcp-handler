---
"mcp-handler": minor
---

Write one OpenTelemetry `SERVER` span per MCP request or notification, following the OpenTelemetry MCP semantic conventions and the `vercel.rpc.*` attributes Vercel's MCP observability reads. Spans are written only when the app registers a tracer provider; `mcp-handler` has no runtime dependency on `@opentelemetry/api`. Set the endpoint label with `telemetry.route`, or turn spans off with `telemetry: false`.

Add `registerMcpOTel()` in `mcp-handler/otel`, which registers `@vercel/otel` with the Vercel project as the service name and removes the raw `User-Agent` and `Referer` attributes `@vercel/otel` adds to spans.

With MCP Events, write `mcp.event.subscription {action}` and `mcp.event.verify_callback` spans around the calls to the application's subscription store and `verifyEndpoint`.
