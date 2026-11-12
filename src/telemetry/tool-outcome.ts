import type { RequestId } from "@modelcontextprotocol/server";
import { toolFailureReporterFor } from "./index";
import type { ToolFailure } from "./message-spans";

/**
 * @experimental Why a tool call failed, recorded on its MCP span in place of
 * the default `execution_failure` / `internal_error`.
 */
export interface ExperimentalToolOutcome {
  /**
   * - `api_error`: an upstream API the tool called failed.
   * - `tool_error`: the tool failed in a way it expects, such as a query
   *   timing out.
   * - `execution_failure`: the tool broke.
   * - `request_error`: the caller asked for something the tool can't do.
   */
  outcome: ToolFailure["outcome"];
  /**
   * A short code from a fixed set, such as `forbidden` or `timeout`, recorded
   * as `error.type`. Lowercase letters, digits and `_ . -`, up to 64
   * characters; anything else falls back to the outcome's default.
   */
  errorType?: string;
}

/** The parts of a tool handler's `ctx` this reads. */
interface ToolCallContext {
  mcpReq: { id: RequestId };
  http?: { req?: Request };
}

const DEFAULT_ERROR_TYPES: Record<ToolFailure["outcome"], string> = {
  api_error: "api_error",
  tool_error: "tool_error",
  execution_failure: "internal_error",
  request_error: "invalid_request",
};

const ERROR_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * @experimental Tells `mcp-handler` why the current tool call failed, so its
 * MCP span reports it. Call it from a tool handler, with the handler's `ctx`,
 * before returning an `isError` result:
 *
 * ```ts
 * experimental_setToolOutcome(ctx, { outcome: "api_error", errorType: "forbidden" });
 * return { isError: true, content: [{ type: "text", text: "Forbidden" }] };
 * ```
 *
 * It applies only when the call's answer is an `isError` result, so it can
 * never mark a successful call as failed. It does nothing when telemetry is
 * off, no tracer provider is registered, or the call can't be identified.
 */
export function experimental_setToolOutcome(
  ctx: ToolCallContext,
  toolOutcome: ExperimentalToolOutcome,
): void {
  try {
    const outcome = toolOutcome.outcome;
    if (!Object.hasOwn(DEFAULT_ERROR_TYPES, outcome)) {
      return;
    }
    let errorType = DEFAULT_ERROR_TYPES[outcome];
    const requested = toolOutcome.errorType;
    if (typeof requested === "string" && ERROR_TYPE.test(requested)) {
      errorType = requested;
    }
    const report = toolFailureReporterFor(ctx.http?.req);
    report?.(ctx.mcpReq.id, { outcome, errorType });
  } catch {
    // Telemetry must never change the tool's answer.
  }
}
