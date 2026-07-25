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
    /**
     * Identifies this stream to the WebSocket control plane, and — when the
     * round is `votable` — the persisted matchup to vote on.
     */
    matchupId: z.string(),
    /**
     * Only present when there is a vote to cast. A non-votable round persists
     * no matchup, so it emits no token rather than an empty-string sentinel a
     * client would have to special-case.
     */
    matchupToken: z.string().optional(),
    /**
     * Only present when the round can be continued, i.e. when a conversation
     * row exists to send back as `conversationId` on the next turn. Absent for
     * a `single` round, which persists nothing: emitting an id that answers
     * `404 Conversation not found` would be worse than emitting none.
     */
    conversationId: z.string().optional(),
    turnIndex: z.number().optional(),
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
  /**
   * Terminal failure of the whole round: the run could not start, or it died
   * mid-stream. Protocols that own an error event (AG-UI's `RUN_ERROR`, the AI
   * SDK's `error` part) map onto this so a client settles instead of hanging on
   * a stream that stops without its usual terminator.
   */
  z.object({
    type: z.literal("run_error"),
    /** Stable machine-readable reason, e.g. `conversation_not_ready`. */
    code: z.string(),
    message: z.string(),
  }),
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
