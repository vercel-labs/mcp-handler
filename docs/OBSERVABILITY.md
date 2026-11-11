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
spans through any registered tracer provider.

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

Tool arguments, results, error messages, user IDs and raw user agents are
never recorded. Tool and prompt names are recorded only when the server
answered with a result, so names a client invents never become attributes.

HTTP requests that never become an MCP message, such as a request rejected by
`withMcpAuth`, get no MCP span.

## Options

```ts
createMcpHandler(initialize, {
  telemetry: { route: "admin" },
});
```

- `telemetry.route`: a bounded label for this endpoint, to tell apart several
  MCP endpoints in one project. Don't derive it from the URL path.
- `telemetry: false`: write no spans.
