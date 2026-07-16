import {
  publicArenaEventSchema,
  type PublicArenaEvent,
} from "../core/events.js";
import type { EventAdapter } from "./event-adapter.js";

/**
 * Native Server-Sent Events transport: the browser demo's default protocol.
 * Each event is framed as an `event:`/`data:` pair; there is no trailing
 * sentinel, so finalize() emits nothing.
 */
export const sseAdapter: EventAdapter = {
  headers: {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  },
  serialize(event: PublicArenaEvent): string {
    publicArenaEventSchema.parse(event);
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  },
  finalize(): string {
    return "";
  },
};
