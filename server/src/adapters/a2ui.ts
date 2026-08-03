import { z } from "zod";
import {
  publicArenaEventSchema,
  type PublicArenaEvent,
} from "../core/events.js";
import type { EventAdapter } from "./event-adapter.js";

/**
 * A2UI adapter (docs/md/architecture.md §Egress): a schema-validated, newline-delimited
 * JSON stream. Each line is one flat, self-describing message so a
 * generative-UI frontend can paint two side-by-side "surfaces" (one per slot)
 * with its own local design system. Every message is validated against the
 * schema before it leaves the process. `surface_init` also
 * carries the signed vote token, so this path is votable without a second
 * channel — flat, self-describing messages are the protocol's own idiom, so the
 * token needs no envelope of its own.
 */
const a2uiMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    v: z.literal("a2ui/1"),
    kind: z.literal("surface_init"),
    matchupId: z.string(),
    // POST /api/arena/vote is unreachable without this token, so it rides the
    // one message every client already has to read. Absent on a non-votable
    // round, which has no token to give.
    matchupToken: z.string().optional(),
    // Absent on a round that persisted no conversation to continue from.
    conversationId: z.string().optional(),
    turnIndex: z.number().optional(),
    surfaces: z.array(z.enum(["A", "B"])),
    // A `single` round paints one surface and carries no vote token, so a
    // client needs these to decide whether to render the vote controls.
    mode: z.enum(["matchup", "single", "shadow"]),
    votable: z.boolean(),
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
  /** Terminal failure of the session, as opposed to one surface's `error`. */
  z.object({
    v: z.literal("a2ui/1"),
    kind: z.literal("session_error"),
    code: z.string(),
    message: z.string(),
  }),
  z.object({
    v: z.literal("a2ui/1"),
    kind: z.literal("steered"),
    instruction: z.string(),
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
            matchupToken: event.matchupToken,
            conversationId: event.conversationId,
            turnIndex: event.turnIndex,
            surfaces: event.slots,
            mode: event.mode,
            votable: event.votable,
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
        case "steered":
          return frame({
            v: "a2ui/1",
            kind: "steered",
            instruction: event.instruction,
          });
        case "run_error":
          return frame({
            v: "a2ui/1",
            kind: "session_error",
            code: event.code,
            message: event.message,
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
