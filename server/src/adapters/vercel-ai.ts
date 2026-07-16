import { z } from "zod";
import {
  publicArenaEventSchema,
  type PublicArenaEvent,
} from "../core/events.js";
import type { EventAdapter } from "./event-adapter.js";

/**
 * Vercel AI SDK adapter (ecosystem, vision §2): speaks the AI SDK UI Message
 * Stream protocol so a stock `useChat` client can consume the arena. Slot A
 * rides the primary text channel (`text-start`/`text-delta`/`text-end`); slot B
 * is multiplexed through custom `data-*` parts (`writer.merge` convention) so a
 * sidecar renderer can paint it beside the main answer. The stream terminates
 * with the protocol's `[DONE]` sentinel, emitted from finalize().
 */
const uiMessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("text-start"), id: z.string() }),
  z.object({ type: z.literal("text-delta"), id: z.string(), delta: z.string() }),
  z.object({ type: z.literal("text-end"), id: z.string() }),
  z.object({
    type: z.literal("data-arena-meta"),
    data: z.object({
      matchupId: z.string(),
      conversationId: z.string(),
      turnIndex: z.number(),
      mainSlot: z.literal("A"),
      dataSlot: z.literal("B"),
    }),
  }),
  z.object({
    type: z.literal("data-arena-b-delta"),
    data: z.object({ text: z.string() }),
  }),
  z.object({
    type: z.literal("data-arena-b-done"),
    data: z.object({}),
  }),
  z.object({
    type: z.literal("data-arena-error"),
    data: z.object({ slot: z.enum(["A", "B"]), message: z.string() }),
  }),
  z.object({ type: z.literal("finish") }),
]);

type UiMessagePart = z.infer<typeof uiMessagePartSchema>;

function frame(parts: UiMessagePart[]): string {
  return parts
    .map(
      (part) => `data: ${JSON.stringify(uiMessagePartSchema.parse(part))}\n\n`,
    )
    .join("");
}

export function createVercelAiAdapter(): EventAdapter {
  let textId = "";

  return {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-vercel-ai-ui-message-stream": "v1",
    },
    serialize(event: PublicArenaEvent): string {
      publicArenaEventSchema.parse(event);
      switch (event.type) {
        case "matchup_started":
          textId = event.matchupId;
          return frame([
            { type: "start" },
            {
              type: "data-arena-meta",
              data: {
                matchupId: event.matchupId,
                conversationId: event.conversationId,
                turnIndex: event.turnIndex,
                mainSlot: "A",
                dataSlot: "B",
              },
            },
            { type: "text-start", id: textId },
          ]);
        case "token":
          return event.slot === "A"
            ? frame([{ type: "text-delta", id: textId, delta: event.token }])
            : frame([
                { type: "data-arena-b-delta", data: { text: event.token } },
              ]);
        case "slot_error":
          return frame([
            {
              type: "data-arena-error",
              data: { slot: event.slot, message: event.message },
            },
          ]);
        case "slot_done":
          return event.slot === "A"
            ? frame([{ type: "text-end", id: textId }])
            : frame([{ type: "data-arena-b-done", data: {} }]);
        case "matchup_done":
          return frame([{ type: "finish" }]);
      }
    },
    finalize(): string {
      return "data: [DONE]\n\n";
    },
  };
}
