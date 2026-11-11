import type {
  JSONRPCMessage,
  McpServer,
  RequestId,
} from "@modelcontextprotocol/server";
import {
  isCallerErrorCode,
  knownMcpMethod,
  protocolVersion,
  rpcErrorOutcome,
  VERCEL_RPC_ATTRIBUTES,
  type MessageFailure,
} from "./attributes";
import {
  activeSpanContext,
  SPAN_KIND_SERVER,
  SPAN_STATUS_ERROR,
  TRACE_FLAG_SAMPLED,
  withRemoteParent,
  type Attributes,
  type McpTracing,
  type SpanContext,
} from "./otel-api";

/**
 * One `SERVER` span that sets `mcp.method.name` per MCP request or
 * notification the server handles, as the OpenTelemetry MCP semantic
 * conventions describe. Vercel counts exactly those spans as MCP messages, so
 * a message must never get two of them, or none.
 *
 * HTTP requests that never become a message (rejected at auth, a `GET`, an
 * unparseable body, a JSON-RPC response from the client) never reach the
 * transport's `onmessage`, so they get no span. Neither does
 * `subscriptions/listen`, which the SDK serves without connecting the server.
 */

type InboundMessage = {
  method: string;
  id?: RequestId;
  /** The tool or prompt the request names, as the client sent it. */
  name?: unknown;
  /**
   * Another pending message has the same ID, so answers can't be matched to
   * their message: the client's names are never recorded for either.
   */
  ambiguous: boolean;
  /** The protocol revision the message's envelope names (2026-07-28). */
  protocolVersion?: string;
  /** The client's trace, from `params._meta.traceparent`. */
  clientTrace?: SpanContext;
  startTime: number;
  parentContext: unknown;
};

type Answer = Extract<JSONRPCMessage, { id: RequestId }> & {
  result?: { isError?: unknown; protocolVersion?: unknown };
  error?: { code?: unknown };
};

/** The attribute that names what a method acts on. */
const TARGET_ATTRIBUTES: Record<string, string> = {
  "tools/call": "gen_ai.tool.name",
  "prompts/get": "gen_ai.prompt.name",
};

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** A W3C `traceparent`, or `undefined` when it is missing or invalid. */
function parseTraceparent(value: unknown): SpanContext | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = TRACEPARENT.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const [, version, traceId, spanId, flags] = match;
  const isValid =
    version !== "ff" && !/^0+$/.test(traceId) && !/^0+$/.test(spanId);
  if (!isValid) {
    return undefined;
  }
  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
    isRemote: true,
  };
}

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
  if (isResult && namesTarget && !message.ambiguous) {
    return message.name as string;
  }
  return undefined;
}

/**
 * The revision the message was served with: the one `initialize` negotiated,
 * or the one a 2026-07-28 envelope names.
 */
function protocolVersionOf(
  message: InboundMessage,
  answer: Answer | "closed" | undefined,
): string | undefined {
  if (message.method === "initialize") {
    const isResult = typeof answer === "object" && answer !== null;
    if (isResult) {
      return protocolVersion(answer.result?.protocolVersion);
    }
    return undefined;
  }
  return message.protocolVersion;
}

/**
 * The parent and links of the message's span. As the MCP semantic conventions
 * describe, the client's trace from `params._meta` is the parent and the HTTP
 * request is linked. A trace the client did not sample stays a link instead:
 * a parent-based sampler would drop the span, and Vercel would not count the
 * message.
 */
function spanParent(message: InboundMessage): {
  parentContext: unknown;
  links: Array<{ context: SpanContext }>;
} {
  const clientTrace = message.clientTrace;
  if (!clientTrace) {
    return { parentContext: message.parentContext, links: [] };
  }

  const isSampled = (clientTrace.traceFlags & TRACE_FLAG_SAMPLED) !== 0;
  const clientParent = isSampled
    ? withRemoteParent(message.parentContext, clientTrace)
    : undefined;
  if (clientParent === undefined) {
    return {
      parentContext: message.parentContext,
      links: [{ context: clientTrace }],
    };
  }

  const links: Array<{ context: SpanContext }> = [];
  const requestSpan = activeSpanContext(message.parentContext);
  if (requestSpan) {
    links.push({ context: requestSpan });
  }
  return { parentContext: clientParent, links };
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
  const version = protocolVersionOf(message, answer);
  if (version) {
    attributes["mcp.protocol.version"] = version;
  }
  if (failure) {
    attributes["error.type"] = failure.errorType;
  }
  const errorCode =
    typeof answer === "object" ? answer.error?.code : undefined;
  if (typeof errorCode === "number") {
    attributes["rpc.response.status_code"] = String(errorCode);
  }

  // A request the server could not serve is the caller's mistake: Vercel
  // still reports it as a `request_error`, but the span is not a server error.
  const isServerError = failure !== undefined && !isCallerErrorCode(errorCode);

  let name = message.method;
  if (target) {
    name = `${message.method} ${target}`;
  }

  try {
    const { parentContext, links } = spanParent(message);
    const span = tracing.tracer.startSpan(
      name,
      {
        kind: SPAN_KIND_SERVER,
        startTime: message.startTime,
        attributes,
        links,
      },
      parentContext,
    );
    if (isServerError) {
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
  const meta = params?._meta as Record<string, unknown> | undefined;
  const message: InboundMessage = {
    method: knownMcpMethod(received.method),
    name: params?.name,
    ambiguous: false,
    protocolVersion: protocolVersion(meta?.[PROTOCOL_VERSION_META_KEY]),
    clientTrace: parseTraceparent(meta?.traceparent),
    startTime: Date.now(),
    parentContext: tracing.activeContext(),
  };
  if ("id" in received) {
    message.id = received.id;
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
    // Messages waiting for an answer, oldest first for each ID.
    const unanswered = new Map<RequestId, InboundMessage[]>();
    const { onmessage, onclose } = transport;
    const send = transport.send.bind(transport);

    transport.onmessage = (received, extra) => {
      const message = readInboundMessage(received, tracing);
      if (message?.id !== undefined) {
        // Before dispatch: the server answers an unknown method synchronously.
        const pending = unanswered.get(message.id) ?? [];
        pending.push(message);
        if (pending.length > 1) {
          for (const sameId of pending) sameId.ambiguous = true;
        }
        unanswered.set(message.id, pending);
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
        const pending = unanswered.get(id);
        const message = pending?.shift();
        if (pending?.length === 0) {
          unanswered.delete(id);
        }
        if (message) {
          recordMessageSpan(tracing, callerAttributes, message, sent as Answer);
        }
      }
      return send(sent, options);
    };

    transport.onclose = () => {
      for (const pending of unanswered.values()) {
        for (const message of pending) {
          recordMessageSpan(tracing, callerAttributes, message, "closed");
        }
      }
      unanswered.clear();
      onclose?.();
    };
  };
}
