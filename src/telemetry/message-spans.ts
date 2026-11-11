import type {
  JSONRPCMessage,
  McpServer,
  RequestId,
} from "@modelcontextprotocol/server";
import {
  knownMcpMethod,
  protocolVersion,
  rpcErrorOutcome,
  VERCEL_RPC_ATTRIBUTES,
  type MessageFailure,
} from "./attributes";
import {
  SPAN_KIND_SERVER,
  SPAN_STATUS_ERROR,
  type Attributes,
  type McpTracing,
} from "./otel-api";

/**
 * One `SERVER` span that sets `mcp.method.name` per MCP request or
 * notification the server handles, as the OpenTelemetry MCP semantic
 * conventions describe. Vercel counts exactly those spans as MCP messages, so
 * a message must never get two of them, or none.
 *
 * HTTP requests that never become a message (rejected at auth, a `GET`, an
 * unparseable body, a JSON-RPC response from the client) never reach the
 * transport's `onmessage`, so they get no span.
 */

type InboundMessage = {
  method: string;
  id?: RequestId;
  /** The tool or prompt the request names, as the client sent it. */
  name?: unknown;
  /** A protocol version the message itself carries (`initialize`). */
  protocolVersion?: string;
  startTime: number;
  parentContext: unknown;
};

type Answer = Extract<JSONRPCMessage, { id: RequestId }> & {
  result?: { isError?: unknown };
  error?: { code?: unknown };
};

/** The attribute that names what a method acts on. */
const TARGET_ATTRIBUTES: Record<string, string> = {
  "tools/call": "gen_ai.tool.name",
  "prompts/get": "gen_ai.prompt.name",
};

function failureOf(method: string, answer: Answer): MessageFailure | undefined {
  if (answer.error) {
    return rpcErrorOutcome(answer.error.code);
  }
  // The SDK answers a tool handler that throws with an `isError` result too,
  // so a declared tool failure and a crash look the same here.
  const isFailedToolCall =
    method === "tools/call" && answer.result?.isError === true;
  if (isFailedToolCall) {
    return { outcome: "execution_failure", errorType: "internal_error" };
  }
  return undefined;
}

/**
 * Only a result proves a tool or prompt name is registered: the SDK answers an
 * unknown one with an error. Client-chosen names are unbounded, so they are
 * never recorded otherwise.
 */
function targetOf(
  message: InboundMessage,
  answer: Answer | "closed" | undefined,
): string | undefined {
  const isResult =
    typeof answer === "object" && answer !== null && "result" in answer;
  const namesTarget =
    message.method in TARGET_ATTRIBUTES && typeof message.name === "string";
  if (isResult && namesTarget) {
    return message.name as string;
  }
  return undefined;
}

/**
 * Writes the message's span in one step once its outcome is known. A span held
 * open while the message is handled would be the first one recorded in an
 * unsampled trace, and `@vercel/otel` ends every other open span of a trace
 * when that one ends.
 *
 * `answer` is the JSON-RPC response, `'closed'` when the connection closed
 * before one was sent, and absent for a notification.
 */
function recordMessageSpan(
  tracing: McpTracing,
  callerAttributes: Attributes,
  message: InboundMessage,
  answer?: Answer | "closed",
): void {
  let failure: MessageFailure | undefined;
  if (answer === "closed") {
    failure = { outcome: "request_error", errorType: "cancelled" };
  } else if (answer) {
    failure = failureOf(message.method, answer);
  }

  const target = targetOf(message, answer);
  const attributes: Attributes = {
    "mcp.method.name": message.method,
    ...callerAttributes,
    [VERCEL_RPC_ATTRIBUTES.outcome]: failure?.outcome ?? "success",
  };
  if (message.method === "tools/call") {
    attributes["gen_ai.operation.name"] = "execute_tool";
  }
  if (target) {
    attributes[TARGET_ATTRIBUTES[message.method]] = target;
  }
  if (message.id !== undefined) {
    attributes["jsonrpc.request.id"] = String(message.id);
  }
  if (message.protocolVersion) {
    attributes["mcp.protocol.version"] = message.protocolVersion;
  }
  if (failure) {
    attributes["error.type"] = failure.errorType;
  }
  const errorCode =
    typeof answer === "object" ? answer.error?.code : undefined;
  if (typeof errorCode === "number") {
    attributes["rpc.response.status_code"] = String(errorCode);
  }

  let name = message.method;
  if (target) {
    name = `${message.method} ${target}`;
  }

  try {
    const span = tracing.tracer.startSpan(
      name,
      { kind: SPAN_KIND_SERVER, startTime: message.startTime, attributes },
      message.parentContext,
    );
    if (failure) {
      span.setStatus({ code: SPAN_STATUS_ERROR });
    }
    span.end();
  } catch {
    // A span must never change the server's answer.
  }
}

function readInboundMessage(
  received: JSONRPCMessage,
  tracing: McpTracing,
): InboundMessage | undefined {
  if (!("method" in received)) {
    return undefined;
  }
  const params = (received as { params?: Record<string, unknown> }).params;
  const method = knownMcpMethod(received.method);
  const message: InboundMessage = {
    method,
    name: params?.name,
    startTime: Date.now(),
    parentContext: tracing.activeContext(),
  };
  if ("id" in received) {
    message.id = received.id;
  }
  if (method === "initialize") {
    message.protocolVersion = protocolVersion(params?.protocolVersion);
  }
  return message;
}

/**
 * Records a span for every request and notification the transport hands to
 * `server`. The SDK connects each per-request server to its own transport, and
 * splits a batch into messages before this sees them.
 *
 * @param callerAttributes What the handler knows about the caller: route,
 * client and auth outcome.
 */
export function traceMcpMessages(
  server: McpServer,
  tracing: McpTracing,
  callerAttributes: Attributes,
): void {
  const connect = server.connect.bind(server);
  server.connect = async (transport) => {
    await connect(transport);
    const unanswered = new Map<RequestId, InboundMessage>();
    const { onmessage, onclose } = transport;
    const send = transport.send.bind(transport);

    transport.onmessage = (received, extra) => {
      const message = readInboundMessage(received, tracing);
      if (message?.id !== undefined) {
        // Before dispatch: the server answers an unknown method synchronously.
        unanswered.set(message.id, message);
      }
      onmessage?.(received, extra);
      const isNotification = message !== undefined && message.id === undefined;
      if (isNotification) {
        recordMessageSpan(tracing, callerAttributes, message);
      }
    };

    transport.send = (sent, options) => {
      const isAnswer =
        !("method" in sent) && "id" in sent && sent.id !== undefined;
      if (isAnswer) {
        const id = sent.id as RequestId;
        const message = unanswered.get(id);
        if (message) {
          unanswered.delete(id);
          recordMessageSpan(tracing, callerAttributes, message, sent as Answer);
        }
      }
      return send(sent, options);
    };

    transport.onclose = () => {
      for (const message of unanswered.values()) {
        recordMessageSpan(tracing, callerAttributes, message, "closed");
      }
      unanswered.clear();
      onclose?.();
    };
  };
}
