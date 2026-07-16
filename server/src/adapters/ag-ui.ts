import { z } from "zod";
import {
  publicArenaEventSchema,
  type PublicArenaEvent,
} from "../core/events.js";
import type { EventAdapter } from "./event-adapter.js";

/**
 * AG-UI adapter (differentiator, vision §2/§5.3): the two arena slots become two
 * concurrent AG-UI text messages inside one run, tagged with `slot` so an
 * agentic frontend (CopilotKit / LangGraph / CrewAI) can route each side to its
 * own column. We emit the subset of the AG-UI event taxonomy the arena needs —
 * lifecycle (`RUN_STARTED`/`RUN_FINISHED`), text streaming
 * (`TEXT_MESSAGE_START`/`_CONTENT`/`_END`), and `CUSTOM` for a single-slot error
 * (the surviving slot keeps streaming). Transport is SSE: one `data:` line per
 * typed event.
 */
const agUiEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("RUN_STARTED"),
    threadId: z.string(),
    runId: z.string(),
  }),
  z.object({
    type: z.literal("TEXT_MESSAGE_START"),
    messageId: z.string(),
    role: z.literal("assistant"),
    slot: z.enum(["A", "B"]),
  }),
  z.object({
    type: z.literal("TEXT_MESSAGE_CONTENT"),
    messageId: z.string(),
    delta: z.string(),
    slot: z.enum(["A", "B"]),
  }),
  z.object({
    type: z.literal("TEXT_MESSAGE_END"),
    messageId: z.string(),
    slot: z.enum(["A", "B"]),
  }),
  z.object({
    type: z.literal("CUSTOM"),
    name: z.literal("slot_error"),
    value: z.object({ slot: z.enum(["A", "B"]), message: z.string() }),
  }),
  z.object({
    type: z.literal("RUN_FINISHED"),
    threadId: z.string(),
    runId: z.string(),
  }),
]);

type AgUiEvent = z.infer<typeof agUiEventSchema>;

const messageId = (runId: string, slot: "A" | "B"): string =>
  `${runId}:${slot}`;

function frame(events: AgUiEvent[]): string {
  return events
    .map((event) => `data: ${JSON.stringify(agUiEventSchema.parse(event))}\n\n`)
    .join("");
}

export function createAgUiAdapter(): EventAdapter {
  let runId = "";
  let threadId = "";

  return {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
    serialize(event: PublicArenaEvent): string {
      publicArenaEventSchema.parse(event);
      switch (event.type) {
        case "matchup_started": {
          runId = event.matchupId;
          threadId = event.conversationId;
          return frame([
            { type: "RUN_STARTED", threadId, runId },
            ...event.slots.map(
              (slot): AgUiEvent => ({
                type: "TEXT_MESSAGE_START",
                messageId: messageId(runId, slot),
                role: "assistant",
                slot,
              }),
            ),
          ]);
        }
        case "token":
          return frame([
            {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: messageId(runId, event.slot),
              delta: event.token,
              slot: event.slot,
            },
          ]);
        case "slot_error":
          return frame([
            {
              type: "CUSTOM",
              name: "slot_error",
              value: { slot: event.slot, message: event.message },
            },
          ]);
        case "slot_done":
          return frame([
            {
              type: "TEXT_MESSAGE_END",
              messageId: messageId(runId, event.slot),
              slot: event.slot,
            },
          ]);
        case "matchup_done":
          return frame([{ type: "RUN_FINISHED", threadId, runId }]);
      }
    },
    finalize(): string {
      return "";
    },
  };
}
