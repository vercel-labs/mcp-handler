# Observability

`createMcpHandler` writes one OpenTelemetry span per MCP request or
notification your server handles, following the
[OpenTelemetry MCP semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md).
On Vercel, those spans power the project's MCP observability: calls by tool,
method, client and outcome, failures by reason, and latency.

Spans are written only when your app registers an OpenTelemetry tracer
provider. `mcp-handler` itself has no runtime dependency on
`@opentelemetry/api`.

## Setup on Vercel

Install the OpenTelemetry packages:

```bash
npm install @vercel/otel @opentelemetry/api @opentelemetry/api-logs
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
`@vercel/otel` 2.x. It names the service after the Vercel project, as Vercel's
default tracing does, and removes the raw `User-Agent` and `Referer`
attributes `@vercel/otel` adds to spans. The removal applies to every span in
the app, not only MCP spans.

`@vercel/otel` is ESM-only, so loading `mcp-handler/otel` with `require` needs
Node.js 20.19+ or 22.12+. Next.js bundles `instrumentation.ts`, so the setup
above is not affected.

### Upgrading from an app that already writes MCP spans

If your app already writes its own `SERVER` spans with `mcp.method.name`, set
`telemetry: false` or remove your spans when you upgrade. Otherwise every MCP
message gets two spans, and Vercel counts it twice. The same applies to
`mcp.event.*` spans that your MCP Events store or `verifyEndpoint` writes,
because `mcp-handler` now writes those spans around the same calls.

### Existing OpenTelemetry setups

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
| `vercel.rpc.outcome`      | `success`, `input_required`, `request_error`, `execution_failure`, or what the tool reported (`api_error`, `tool_error`) |
| `vercel.rpc.client.name`  | A fixed client vocabulary (`claude`, `cursor`, `codex`, …, `other`) from the user agent and OAuth client ID |
| `vercel.rpc.route`        | The `telemetry.route` option, `mcp` by default                                                   |
| `vercel.rpc.auth.outcome` | `authorized` with a token verified by `withMcpAuth`, otherwise `anonymous`                       |
| `error.type`              | On failure: `invalid_request`, `not_found`, `forbidden`, `rate_limited`, `cancelled` or `internal_error` |
| `rpc.response.status_code`| The JSON-RPC error code, when the answer is an error                                             |

A JSON-RPC parse, request, method or params error (including an unknown tool
or prompt), a missing client capability, an unsupported protocol version,
tool arguments that fail the tool's input schema, and a request the client
cancelled are `request_error`s. A request still pending when the server closes
the connection itself is an `execution_failure`.

A tool, prompt or resource that needs more input from the user
(`input_required` on 2026-07-28, or a URL elicitation) is `input_required`,
not a failure. The client's follow-up call with that input gets its own span. A tool call answered with `isError`, including
a tool that throws, and any other JSON-RPC error is an `execution_failure`.

Only the server's own failures (`execution_failure`, and a reported `api_error`
or `tool_error`) set the span status to `ERROR`. A request the
server could not serve, invalid tool arguments and a cancelled request are the
caller's, as the MCP semantic conventions describe for JSON-RPC errors.

Notification spans count notifications; they are not timed. The SDK runs
notification handlers after the span is written, so a slow or failing handler
doesn't show. Requests that reuse an ID within one batch, which the protocol
doesn't allow, are counted correctly, but their outcomes and durations may be
swapped.

When a request carries the client's trace in `params._meta` (the W3C
`traceparent` and `tracestate` keys SEP-414 defines), the message span and its
MCP Events spans link it, and keep the HTTP request as their parent. This is
the only behavior; it isn't configurable.

The MCP semantic conventions suggest the client's trace as the parent by
default. `mcp-handler` doesn't follow that default because:

- A client could make your server record spans your own sampling would drop,
  or drop spans your sampling would keep. As a link, a span is recorded exactly
  when the request is sampled, so Vercel's counts follow your sampling rule.
- The client's own spans are exported to the client's backend, not yours. On
  the client's trace, your span has a parent you never receive, so your trace
  view shows it as a fragment without a root, cut off from the request that
  served it.
- Your spans keep trace IDs your platform chose, so a client can't place them
  in a trace of its choosing or collide with your traces.

To find a call from the client's side, follow the span's link, or log the
client's trace ID from `params._meta` next to your own trace ID.

`mcp-handler` never records tool arguments, results, error messages, user IDs
or raw user agents. Tool and prompt names are recorded only when the server
answered with a result or a URL elicitation request, which only a registered
tool or prompt can send, so names a client invents never become attributes.

HTTP requests that never reach your server get no MCP span: a request
rejected by `withMcpAuth`, and one the MCP SDK rejects first (an invalid
envelope, an unsupported protocol revision, mismatched headers). Neither does
`subscriptions/listen`, which the MCP SDK serves as a long-lived stream
without handing it to your server.

## Reporting why a tool failed

By default, a tool call answered with an `isError` result is an
`execution_failure` with `error.type: internal_error`. When the tool knows
why it failed, it can say so with `experimental_setToolOutcome`, using the
handler's `ctx`, before it returns:

```ts
import { createMcpHandler, experimental_setToolOutcome } from "mcp-handler";

const handler = createMcpHandler((server) => {
  server.registerTool("list_projects", {}, async (ctx) => {
    const response = await fetch("https://api.example.com/projects");
    if (!response.ok) {
      experimental_setToolOutcome(ctx, {
        outcome: "api_error",
        errorType: response.status === 403 ? "forbidden" : "upstream_error",
      });
      return { isError: true, content: [{ type: "text", text: "Failed" }] };
    }
    return { content: [{ type: "text", text: await response.text() }] };
  });
});
```

| Outcome             | Use it when                                          | Default `error.type` |
| ------------------- | ---------------------------------------------------- | -------------------- |
| `api_error`         | An upstream API the tool called failed               | `api_error`          |
| `tool_error`        | The tool failed in a way it expects, such as a timeout | `tool_error`       |
| `execution_failure` | The tool broke                                       | `internal_error`     |
| `request_error`     | The caller asked for something the tool can't do     | `invalid_request`    |

`errorType` must be a short code (lowercase letters, digits and `_ . -`, up to
64 characters), such as `forbidden` or `timeout`; anything else falls back to
the default. The report applies only when the call's answer is an `isError`
result, so it can never mark a successful call as failed, and every outcome
except `request_error` sets the span status to `ERROR`. It does nothing when
telemetry is off or no tracer provider is registered.

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
`not_found`, `cancelled` or `internal_error`); only `internal_error` sets the
span status to `ERROR`. Callback URLs, subscription IDs,
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
