import { z } from "zod";
import {
  publicArenaEventSchema,
  type PublicArenaEvent,
} from "../core/events.js";
import type { EventAdapter } from "./event-adapter.js";

/**
 * A2UI adapter (differentiator, vision §2): a schema-validated, newline-delimited
 * JSON stream. Each line is one flat, self-describing message so a
 * generative-UI frontend can paint two side-by-side "surfaces" (one per slot)
 * with its own local design system. Every message is validated against the
 * schema before it leaves the process (vision §5 rule 3).
 */
const a2uiMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    v: z.literal("a2ui/1"),
    kind: z.literal("surface_init"),
    matchupId: z.string(),
    conversationId: z.string(),
    turnIndex: z.number(),
    surfaces: z.array(z.enum(["A", "B"])),
  }),
  z.object({
    v: z.literal("a2ui/1"),
    kind: z.literal("text_append"),
    surface: z.enum(["A", "B"]),
    text: z.string(),
  }),
  z.object({
    v: z.literal("a2ui/1"),
    kind: z.literal("error"),
    surface: z.enum(["A", "B"]),
    message: z.string(),
  }),
  z.object({
    v: z.literal("a2ui/1"),
    kind: z.literal("surface_done"),
    surface: z.enum(["A", "B"]),
  }),
  z.object({ v: z.literal("a2ui/1"), kind: z.literal("session_done") }),
]);

type A2uiMessage = z.infer<typeof a2uiMessageSchema>;

function frame(message: A2uiMessage): string {
  return `${JSON.stringify(a2uiMessageSchema.parse(message))}\n`;
}

export function createA2uiAdapter(): EventAdapter {
  return {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
    serialize(event: PublicArenaEvent): string {
      publicArenaEventSchema.parse(event);
      switch (event.type) {
        case "matchup_started":
          return frame({
            v: "a2ui/1",
            kind: "surface_init",
            matchupId: event.matchupId,
            conversationId: event.conversationId,
            turnIndex: event.turnIndex,
            surfaces: event.slots,
          });
        case "token":
          return frame({
            v: "a2ui/1",
            kind: "text_append",
            surface: event.slot,
            text: event.token,
          });
        case "slot_error":
          return frame({
            v: "a2ui/1",
            kind: "error",
            surface: event.slot,
            message: event.message,
          });
        case "slot_done":
          return frame({
            v: "a2ui/1",
            kind: "surface_done",
            surface: event.slot,
          });
        case "matchup_done":
          return frame({ v: "a2ui/1", kind: "session_done" });
      }
    },
    finalize(): string {
      return "";
    },
  };
}
