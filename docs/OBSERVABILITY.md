# Observability

`createMcpHandler` writes one OpenTelemetry span per MCP request or
notification, following the
[OpenTelemetry MCP semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md).
On Vercel, those spans power the project's MCP observability: calls by tool,
method, client and outcome, failures by reason, and latency.

Spans are written only when your app registers an OpenTelemetry tracer
provider. `mcp-handler` itself has no runtime dependency on
`@opentelemetry/api`.

## Setup on Vercel

Install the OpenTelemetry packages:

```bash
npm install @vercel/otel @opentelemetry/api
```

Register OpenTelemetry in `instrumentation.ts` at the project root (or in
`src/` when your app uses it):

```ts
import { registerMcpOTel } from "mcp-handler/otel";

export function register() {
  registerMcpOTel();
}
```

`registerMcpOTel` takes the same configuration as `registerOTel` from
`@vercel/otel`. It names the service after the Vercel project, as Vercel's
default tracing does, and removes the raw `User-Agent` and `Referer`
attributes `@vercel/otel` adds to spans.

If you already call `registerOTel` yourself, keep it: `mcp-handler` writes its
spans through any registered tracer provider. In that case `@vercel/otel`
still copies the raw `User-Agent` and `Referer` of the HTTP request onto the
spans it treats as roots; `registerMcpOTel` is what removes them.

Vercel collects traces only when the project has a sampling rule. The MCP
views count the spans Vercel stores, so trace 100% of your MCP route's
requests for exact counts. Spans from clients that send a not-sampled
`traceparent` are dropped.

## What each span records

Every MCP message gets one `SERVER` span named `{method}`, or
`{method} {target}` for `tools/call` and `prompts/get`:

| Attribute                 | Value                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `mcp.method.name`         | The MCP method, or `other` for unknown methods                                                   |
| `gen_ai.tool.name`        | The tool of a `tools/call`, when the server has it                                               |
| `gen_ai.prompt.name`      | The prompt of a `prompts/get`, when the server has it                                            |
| `gen_ai.operation.name`   | `execute_tool` on `tools/call`                                                                   |
| `jsonrpc.request.id`      | The request ID; absent on notifications                                                          |
| `mcp.protocol.version`    | The negotiated protocol revision, when known                                                     |
| `vercel.rpc.outcome`      | `success`, `request_error` or `execution_failure`                                                |
| `vercel.rpc.client.name`  | A fixed client vocabulary (`claude`, `cursor`, `codex`, …, `other`) from the user agent and OAuth client ID |
| `vercel.rpc.route`        | The `telemetry.route` option, `mcp` by default                                                   |
| `vercel.rpc.auth.outcome` | `authorized` with a token verified by `withMcpAuth`, otherwise `anonymous`                       |
| `error.type`              | On failure: `invalid_request`, `not_found`, `forbidden`, `rate_limited`, `cancelled` or `internal_error` |
| `rpc.response.status_code`| The JSON-RPC error code, when the answer is an error                                             |

A JSON-RPC parse, request, method or params error (including an unknown tool
or prompt) is a `request_error`. A tool call answered with `isError`, including
a tool that throws, and any other JSON-RPC error is an `execution_failure`.

As the MCP semantic conventions describe, the JSON-RPC errors that mean the
caller sent a request the server could not serve (`-32700`, `-32600`,
`-32601`, `-32602` and `-32002`) don't set the span status to `ERROR`. Every
other failure does.

When a request carries the client's trace in `params._meta` (the W3C
`traceparent` and `tracestate` keys SEP-414 defines), the message span and its
MCP Events spans continue it, and link the HTTP request's span. When the
client did not sample that trace, they keep the HTTP request as their parent
and link the client's trace instead, so the message is still recorded. Other
propagation formats in `params._meta` are not read: on Vercel, `@vercel/otel`'s
runtime propagator replaces whatever the registered propagators extract with
the Vercel request's own trace.

`mcp-handler` never records tool arguments, results, error messages, user IDs
or raw user agents. Tool and prompt names are recorded only when the server
answered with a result, so names a client invents never become attributes.

HTTP requests that never become an MCP message, such as a request rejected by
`withMcpAuth`, get no MCP span. Neither does `subscriptions/listen`, which the
MCP SDK serves as a long-lived stream without handing it to your server.

## MCP Events

With [MCP Events](MCP_EVENTS.md), `events/list`, `events/subscribe` and
`events/unsubscribe` are MCP messages like any other. Each subscription also
gets a span for every call `mcp-handler` makes to your adapters:

| Span                                   | Kind       | Attributes                                                                                                                  |
| -------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `mcp.event.subscription prepare`       | `INTERNAL` | `vercel.mcp.subscription.action`, `vercel.mcp.subscription.outcome` (`prepared`), `vercel.mcp.event.type`                    |
| `mcp.event.verify_callback`            | `CLIENT`   | `vercel.mcp.event.outcome` (`verified` or `failed`), `vercel.mcp.event.type`, and the failure reason (`timeout`, `http_4xx`, …) as `error.type` |
| `mcp.event.subscription subscribe`     | `INTERNAL` | `vercel.mcp.subscription.outcome` (`subscribed`), `vercel.mcp.event.type`                                                   |
| `mcp.event.subscription unsubscribe`   | `INTERNAL` | `vercel.mcp.subscription.outcome` (`removed` or `not_found`)                                                                 |

Every event span also carries `vercel.rpc.client.name` and `vercel.rpc.route`.
A step that throws gets a short `error.type` (`rate_limited`, `forbidden`,
`not_found`, `cancelled` or `internal_error`). Callback URLs, subscription IDs,
secrets, arguments and error messages are never recorded, and the event name
is recorded only once it matched your catalog.

Event delivery happens in your own worker, so `mcp-handler` writes no delivery
spans.

## Options

```ts
createMcpHandler(initialize, {
  telemetry: { route: "admin" },
});
```

- `telemetry.route`: a bounded label for this endpoint, to tell apart several
  MCP endpoints in one project. Don't derive it from the URL path.
- `telemetry: false`: write no spans.
