import { handleCallback } from "@vercel/queue";
import { vercelQueueConsumer } from "mcp-handler/events";
import { events } from "../../../lib/events";

// Invoked by Vercel Queues for the "mcp-events" topic (see vercel.json).
export const POST = vercelQueueConsumer(events, handleCallback);
