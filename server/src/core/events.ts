import { z } from "zod";

export type ArenaSlot = "A" | "B";

const slotSchema = z.enum(["A", "B"]);

/**
 * The exact wire shape of every event an adapter is allowed to emit. Adapters
 * validate against this at the transport boundary so a malformed chunk fails
 * loudly instead of reaching a client.
 */
export const publicArenaEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("matchup_started"),
    matchupId: z.string(),
    matchupToken: z.string(),
    conversationId: z.string(),
    turnIndex: z.number(),
    slots: z.array(slotSchema),
    mode: z.enum(["matchup", "single", "shadow"]),
    votable: z.boolean(),
  }),
  z.object({ type: z.literal("token"), slot: slotSchema, token: z.string() }),
  z.object({
    type: z.literal("slot_error"),
    slot: slotSchema,
    message: z.string(),
  }),
  z.object({ type: z.literal("slot_done"), slot: slotSchema }),
  z.object({ type: z.literal("matchup_done") }),
]);

export type ArenaEvent =
  | { type: "token"; slot: ArenaSlot; token: string }
  | { type: "slot_error"; slot: ArenaSlot; message: string }
  | {
      type: "slot_done";
      slot: ArenaSlot;
      content: string;
      latencyMs: number;
      ttftMs: number | null;
      streamDurationMs: number;
      outputTokenCount: number;
      tokenCountSource: "provider" | "estimated";
      markdownDensity: number;
      modelVersion: string | null;
      error: string | null;
    }
  | { type: "matchup_done" };

export type PublicArenaEvent = z.infer<typeof publicArenaEventSchema>;

export function toPublicEvent(event: ArenaEvent): PublicArenaEvent {
  if (event.type === "slot_done") {
    return { type: "slot_done", slot: event.slot };
  }
  return event;
}
