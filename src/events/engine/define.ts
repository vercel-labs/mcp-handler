import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type {
  ExperimentalMcpEventAuthorizationContext,
  ExperimentalMcpEventContext,
  ExperimentalMcpEventDefinition,
} from "../types";

type Output<Schema> = Schema extends StandardSchemaWithJSON<any, infer Value>
  ? Value
  : never;

/** @experimental Options for `defineEvent`. */
export interface McpEventOptions<
  Input extends StandardSchemaWithJSON,
  Payload extends StandardSchemaWithJSON,
> {
  name: string;
  description?: string;
  /**
   * Subscription arguments (filters). Must not transform input, because
   * arguments are part of subscription identity.
   */
  input: Input;
  /** The delivered `data`. Must not transform values. */
  payload: Payload;
  /**
   * Whether this principal may receive events for these arguments, from
   * current permissions. Runs at subscribe time and before every delivery;
   * returning anything but `true` ends the subscription.
   */
  authorize(
    args: Output<Input>,
    context: ExperimentalMcpEventAuthorizationContext,
  ): boolean | Promise<boolean>;
  /** Hide the event from callers who may not discover it. */
  authorizeDiscovery?(
    context: ExperimentalMcpEventContext,
  ): boolean | Promise<boolean>;
  /**
   * Route each emitted event only to subscriptions in the same partition
   * instead of scanning every subscription. Both functions must return the
   * same string for arguments and data that belong together.
   */
  partitionBy?: {
    arguments(args: Output<Input>): string;
    payload(data: Output<Payload>): string;
  };
  /** Final filter within a partition. Omit to deliver to every subscription. */
  match?(args: Output<Input>, data: Output<Payload>): boolean;
}

/** @experimental An event definition created by `defineEvent`. */
export interface McpEvent<Args = any, Data = any>
  extends ExperimentalMcpEventDefinition {
  readonly partitionBy?: {
    arguments(args: Args): string;
    payload(data: Data): string;
  };
  readonly match?: (args: Args, data: Data) => boolean;
  /** Type-only: the argument and payload types. */
  readonly "~types"?: { arguments: Args; payload: Data };
}

/**
 * Define an event type once and share it between the MCP route, wherever the
 * server emits events, and the delivery consumer.
 *
 * @experimental Webhook delivery per draft SEP-3415.
 */
export function defineEvent<
  Input extends StandardSchemaWithJSON,
  Payload extends StandardSchemaWithJSON,
>(
  options: McpEventOptions<Input, Payload>,
): McpEvent<Output<Input>, Output<Payload>> {
  if (typeof options.name !== "string" || !options.name)
    throw new TypeError("Event name required");
  return {
    name: options.name,
    ...(options.description !== undefined
      ? { description: options.description }
      : {}),
    inputSchema: options.input,
    payloadSchema: options.payload,
    authorize: (args, context) =>
      options.authorize(args as Output<Input>, context),
    ...(options.authorizeDiscovery
      ? { authorizeDiscovery: options.authorizeDiscovery }
      : {}),
    ...(options.partitionBy ? { partitionBy: options.partitionBy } : {}),
    ...(options.match ? { match: options.match } : {}),
  };
}
