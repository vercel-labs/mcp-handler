import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { request } from "node:https";
import { vi } from "vitest";
import { Webhook } from "standardwebhooks";

// Requires vi.mock("node:https") with a vi.fn() request in the test file.

export interface ReceivedRequest {
  url: string;
  body: string;
  json: any;
  headers: Record<string, string>;
}

export type Reply = {
  status?: number;
  headers?: Record<string, string>;
} | void;

/**
 * Accepts every signed POST, echoes verification challenges, and records
 * what was sent. `reply` can pick a status or wait (e.g. to race a request).
 */
export function fakeReceiver(
  reply: (received: ReceivedRequest) => Reply | Promise<Reply> = () => {},
) {
  const received: ReceivedRequest[] = [];
  vi.mocked(request).mockImplementation((...args: unknown[]) => {
    const url = String(args[0]);
    const { headers } = args[1] as { headers: Record<string, string> };
    const callback = args[2] as (response: unknown) => void;
    const response = Object.assign(new PassThrough(), {
      statusCode: 200,
      headers: {} as Record<string, string>,
      complete: false,
    });
    const req = Object.assign(new EventEmitter(), {
      end: (body: string) => {
        const entry = { url, body, json: JSON.parse(body), headers };
        received.push(entry);
        void Promise.resolve(reply(entry)).then((custom) => {
          response.statusCode = custom?.status ?? 200;
          response.headers = custom?.headers ?? {};
          callback(response);
          response.complete = true;
          response.end(
            entry.json.type === "verification"
              ? JSON.stringify({ challenge: entry.json.challenge })
              : "",
          );
        });
      },
      destroy: () => response.destroy(),
    });
    return req as never;
  });
  return {
    received,
    events: () => received.filter((entry) => entry.json.type === undefined),
    verifications: () =>
      received.filter((entry) => entry.json.type === "verification"),
    controls: () =>
      received.filter(
        (entry) =>
          entry.json.type !== undefined && entry.json.type !== "verification",
      ),
    verifies: (entry: ReceivedRequest, secret: string) => {
      try {
        new Webhook(secret).verify(entry.body, entry.headers);
        return true;
      } catch {
        return false;
      }
    },
  };
}
