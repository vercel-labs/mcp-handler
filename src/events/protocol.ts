import {
  CLIENT_CAPABILITIES_META_KEY,
  type ServerCapabilities,
  type ServerContext,
} from "@modelcontextprotocol/server";

/** The SEP-3415 extension identifier. */
export const EVENTS_EXTENSION = "io.modelcontextprotocol/events";

/**
 * @experimental The Events revision a client speaks: SEP-3415, or the earlier
 * design sketch that ChatGPT implements (top-level capability, sketch error
 * codes, no `gap`/`terminated` notices).
 */
export type ExperimentalMcpEventsDialect = "sep-3415" | "chatgpt";

export type EventsErrorName =
  | "NotFound"
  | "Forbidden"
  | "ResourceExhausted"
  | "Unsupported"
  | "CallbackEndpointError";

const codes: Record<
  ExperimentalMcpEventsDialect,
  Record<EventsErrorName, number>
> = {
  // Provisional until SEP-3415 is accepted.
  "sep-3415": {
    NotFound: -32023,
    Forbidden: -32024,
    ResourceExhausted: -32025,
    Unsupported: -32026,
    CallbackEndpointError: -32027,
  },
  chatgpt: {
    NotFound: -32011,
    Forbidden: -32012,
    ResourceExhausted: -32013,
    Unsupported: -32014,
    CallbackEndpointError: -32015,
  },
};

export function errorCode(
  dialect: ExperimentalMcpEventsDialect,
  name: EventsErrorName,
): number {
  return codes[dialect][name];
}

/** Adapters may throw either numbering; map it back to the semantic name. */
export function errorName(code: number): EventsErrorName | undefined {
  for (const table of Object.values(codes))
    for (const [name, value] of Object.entries(table))
      if (value === code) return name as EventsErrorName;
  return undefined;
}

/**
 * SEP-3415 clients may declare the extension in their per-request
 * capabilities. Clients that don't, including ChatGPT and every request on
 * pre-2026-07-28 revisions (which have no envelope), get the compat dialect.
 */
export function detectDialect(
  ctx: ServerContext,
  chatgptCompat: boolean,
): ExperimentalMcpEventsDialect {
  if (!chatgptCompat) return "sep-3415";
  // The SDK types the lifted envelope as an empty object.
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as
    | { extensions?: Record<string, unknown> }
    | undefined;
  return capabilities?.extensions?.[EVENTS_EXTENSION] !== undefined
    ? "sep-3415"
    : "chatgpt";
}

/** ChatGPT reads the top-level key; SEP-3415 clients read the extension. */
export function eventsCapabilities(chatgptCompat: boolean): ServerCapabilities {
  return {
    extensions: { [EVENTS_EXTENSION]: {} },
    ...(chatgptCompat ? { events: {} } : {}),
  } as ServerCapabilities;
}
