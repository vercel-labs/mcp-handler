import {
  fromJsonSchema,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type { ExperimentalMcpSubscriptionState } from "./types";

const object = { type: "object", additionalProperties: true } as const;
const name = { type: "string", minLength: 1 } as const;
const integer = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;

export const listParams: StandardSchemaWithJSON<{ cursor?: string }> =
  fromJsonSchema({
    type: "object",
    properties: { cursor: { type: "string" } },
  });

export interface SubscriptionParams {
  name: string;
  arguments: Record<string, unknown>;
  delivery: { mode: string; url: string; secret: string };
  cursor?: string | null;
  maxAgeMs?: number;
  ttlMs?: number | null;
}

export const subscribeParams: StandardSchemaWithJSON<SubscriptionParams> =
  fromJsonSchema({
    type: "object",
    required: ["name", "arguments", "delivery"],
    properties: {
      name,
      arguments: object,
      delivery: {
        type: "object",
        required: ["mode", "url", "secret"],
        properties: { mode: name, url: name, secret: name },
      },
      cursor: { type: ["string", "null"] },
      maxAgeMs: integer,
      ttlMs: { ...integer, type: ["integer", "null"] },
    },
  });

export const unsubscribeParams: StandardSchemaWithJSON<
  Pick<SubscriptionParams, "name" | "arguments"> & { delivery: { url: string } }
> = fromJsonSchema({
  type: "object",
  required: ["name", "arguments", "delivery"],
  properties: {
    name,
    arguments: object,
    delivery: {
      type: "object",
      required: ["url"],
      properties: { url: name },
    },
  },
});

export const webhookFailures = [
  "connection_refused",
  "timeout",
  "tls_error",
  "http_4xx",
  "http_5xx",
  "challenge_failed",
] as const;

export const subscriptionState: StandardSchemaWithJSON<ExperimentalMcpSubscriptionState> =
  fromJsonSchema({
    type: "object",
    required: ["cursor", "truncated"],
    additionalProperties: false,
    properties: {
      cursor: { type: ["string", "null"] },
      truncated: { type: "boolean" },
      deliveryStatus: {
        type: "object",
        required: ["active", "lastError"],
        additionalProperties: false,
        properties: {
          active: { type: "boolean" },
          lastDeliveryAt: { type: "string", format: "date-time" },
          lastError: { enum: [...webhookFailures, null] },
          failedSince: { type: "string", format: "date-time" },
          throttled: { type: "boolean" },
          retryAfterMs: { type: "integer", minimum: 0 },
        },
      },
    },
  });
