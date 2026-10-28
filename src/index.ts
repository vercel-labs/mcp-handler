// Re-export the framework-agnostic HTTP adapter
export { default as createMcpHandler } from "./handler";
export type { McpHandlerOptions, WebMcpOptions } from "./handler";

export { experimental_registerMcpEvents } from "./events/register";
export {
  experimental_verifyMcpWebhookEndpoint,
  experimental_deliverMcpEvent,
} from "./events/webhook";
export type {
  ExperimentalMcpEventDeliveryOptions,
  ExperimentalMcpWebhookResult,
} from "./events/webhook";
export {
  experimental_validateMcpEventDelivery,
  ExperimentalMcpEventDeliveryError,
} from "./events/validate-delivery";
export type {
  ExperimentalMcpEventAuthorizationContext,
  ExperimentalMcpEventContext,
  ExperimentalMcpEventDeliveryErrorCode,
  ExperimentalMcpEventDeliveryValidationOptions,
  ExperimentalMcpEventDefinition,
  ExperimentalMcpEventsOptions,
  ExperimentalMcpSubscriptionKey,
  ExperimentalMcpSubscriptionState,
  ExperimentalMcpSubscriptionStore,
  ExperimentalMcpWebhookDelivery,
  ExperimentalMcpWebhookFailure,
  ExperimentalMcpWebhookSubscription,
} from "./events/types";

/**
 * @deprecated Use withMcpAuth instead
 */
export { withMcpAuth as experimental_withMcpAuth } from "./auth/auth-wrapper";

export { withMcpAuth } from "./auth/auth-wrapper";

export {
  protectedResourceHandler,
  generateProtectedResourceMetadata,
  metadataCorsOptionsRequestHandler,
} from "./auth/auth-metadata";

export { getPublicOrigin, getPublicUrl } from "./lib/url";
