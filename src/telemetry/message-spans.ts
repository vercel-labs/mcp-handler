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
  SPAN_KIND_SERVER,
  SPAN_STATUS_ERROR,
  type Attributes,
  type McpTracing,
  type SpanContext,
} from "./otel-api";
import { clientTraceFrom, selectSpanParent } from "./trace-context";

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
const MAX_REQUEST_ID_LENGTH = 128;
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
  try {
    writeMessageSpan(tracing, callerAttributes, message, answer);
  } catch {
    // A span must never change the server's answer.
  }
}

function writeMessageSpan(
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
  const requestId = message.id === undefined ? undefined : String(message.id);
  // IDs are unique per request anyway; the cap only keeps huge ones out.
  const isStorableId =
    requestId !== undefined && requestId.length <= MAX_REQUEST_ID_LENGTH;
  if (isStorableId) {
    attributes["jsonrpc.request.id"] = requestId;
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

  const { parentContext, links } = selectSpanParent(
    message.parentContext,
    message.clientTrace,
  );
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
    clientTrace: clientTraceFrom(meta),
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
    // Messages waiting for an answer, oldest first for each ID. Answers take
    // them in order through a cursor rather than `shift()`, so a batch that
    // repeats one ID stays linear.
    const unanswered = new Map<
      RequestId,
      { messages: InboundMessage[]; next: number }
    >();
    const { onmessage, onclose } = transport;
    const send = transport.send.bind(transport);

    transport.onmessage = (received, extra) => {
      const message = trackInbound(received);
      onmessage?.(received, extra);
      const isNotification = message !== undefined && message.id === undefined;
      if (isNotification) {
        recordMessageSpan(tracing, callerAttributes, message);
      }
    };

    /** Reads and queues an inbound message; never throws. */
    function trackInbound(received: JSONRPCMessage): InboundMessage | undefined {
      try {
        const message = readInboundMessage(received, tracing);
        if (message?.id !== undefined) {
          // Before dispatch: the server answers an unknown method synchronously.
          const pending = unanswered.get(message.id);
          if (pending) {
            // The first collision marks the message already waiting; later ones
            // only need to mark themselves.
            if (pending.messages.length === 1) {
              pending.messages[0].ambiguous = true;
            }
            message.ambiguous = true;
            pending.messages.push(message);
          } else {
            unanswered.set(message.id, { messages: [message], next: 0 });
          }
        }
        return message;
      } catch {
        return undefined;
      }
    }

    /** Takes the oldest message waiting for this answer; never throws. */
    function takeAnswered(sent: JSONRPCMessage): InboundMessage | undefined {
      try {
        const isAnswer =
          !("method" in sent) && "id" in sent && sent.id !== undefined;
        if (!isAnswer) {
          return undefined;
        }
        const id = sent.id as RequestId;
        const pending = unanswered.get(id);
        if (!pending) {
          return undefined;
        }
        const message = pending.messages[pending.next];
        pending.next += 1;
        if (pending.next >= pending.messages.length) {
          unanswered.delete(id);
        }
        return message;
      } catch {
        return undefined;
      }
    }

    transport.send = (sent, options) => {
      const message = takeAnswered(sent);
      if (message) {
        recordMessageSpan(tracing, callerAttributes, message, sent as Answer);
      }
      return send(sent, options);
    };

    transport.onclose = () => {
      for (const pending of unanswered.values()) {
        for (const message of pending.messages.slice(pending.next)) {
          recordMessageSpan(tracing, callerAttributes, message, "closed");
        }
      }
      unanswered.clear();
      onclose?.();
    };
  };
}
