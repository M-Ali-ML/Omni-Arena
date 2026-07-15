export type ArenaSlot = "A" | "B";

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

export type PublicArenaEvent =
  | {
      type: "matchup_started";
      matchupId: string;
      matchupToken: string;
      conversationId: string;
      turnIndex: number;
      slots: ArenaSlot[];
    }
  | { type: "token"; slot: ArenaSlot; token: string }
  | { type: "slot_error"; slot: ArenaSlot; message: string }
  | { type: "slot_done"; slot: ArenaSlot }
  | { type: "matchup_done" };

export function toPublicEvent(event: ArenaEvent): PublicArenaEvent {
  if (event.type === "slot_done") {
    return { type: "slot_done", slot: event.slot };
  }
  return event;
}
