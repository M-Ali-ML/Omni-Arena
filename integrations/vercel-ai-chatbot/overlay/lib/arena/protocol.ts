/**
 * The OmniArena side of the wire, expressed in this app's types.
 *
 * OmniArena's `?protocol=vercel-ai` adapter frames one blind matchup as an AI
 * SDK UI Message Stream: slot A rides the normal assistant text channel and
 * slot B is multiplexed through `data-arena-*` parts. Everything the UI needs
 * about a round therefore lives on the assistant message itself, which also
 * means a reloaded chat can be rehydrated from the database with no extra
 * bookkeeping.
 */
import type { ChatMessage } from "@/lib/types";

export type ArenaSlot = "A" | "B";
export type ArenaMode = "matchup" | "single" | "shadow";
export type ArenaVote = "left" | "right" | "both_good" | "both_bad" | "skip";

export type ArenaMeta = {
  matchupId: string;
  /** Absent on a round with nothing to vote on; older servers sent `""`. */
  matchupToken?: string;
  /**
   * Absent on a round OmniArena persisted nothing for, which is how it says
   * there is no conversation to continue — sending one back anyway earned a
   * `404 Conversation not found`.
   */
  conversationId?: string;
  turnIndex?: number;
  mainSlot: ArenaSlot;
  dataSlot: ArenaSlot;
  /** Present since the adapter forwards the trigger mode; optional for safety. */
  mode?: ArenaMode;
  votable?: boolean;
};

export type ArenaSlotError = { slot: ArenaSlot; message: string };

export type ArenaRevealedModel = { id?: string; displayName: string };

export type ArenaReveal = {
  vote: ArenaVote;
  models: Record<ArenaSlot, ArenaRevealedModel>;
};

export type ArenaMatchupView = {
  meta: ArenaMeta;
  mode: ArenaMode;
  votable: boolean;
  slotA: string;
  slotB: string;
  slotBDone: boolean;
  errors: ArenaSlotError[];
  reveal: ArenaReveal | null;
};

export const ARENA_VOTE_OPTIONS: { value: ArenaVote; label: string }[] = [
  { label: "A is better", value: "left" },
  { label: "B is better", value: "right" },
  { label: "Both good", value: "both_good" },
  { label: "Both bad", value: "both_bad" },
  { label: "Skip", value: "skip" },
];

/** Votes that leave a single winning response for OmniArena to continue from. */
export function isDecisiveVote(vote: ArenaVote): boolean {
  return vote === "left" || vote === "right";
}

type UnknownPart = { type: string; data?: unknown; text?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readMeta(data: unknown): ArenaMeta | null {
  const record = asRecord(data);
  if (!record || typeof record.matchupId !== "string") {
    return null;
  }
  return {
    ...(typeof record.conversationId === "string"
      ? { conversationId: record.conversationId }
      : {}),
    dataSlot: "B",
    mainSlot: "A",
    matchupId: record.matchupId,
    ...(typeof record.matchupToken === "string" && record.matchupToken !== ""
      ? { matchupToken: record.matchupToken }
      : {}),
    mode:
      record.mode === "single" || record.mode === "shadow"
        ? record.mode
        : "matchup",
    ...(typeof record.turnIndex === "number"
      ? { turnIndex: record.turnIndex }
      : {}),
    votable: typeof record.votable === "boolean" ? record.votable : undefined,
  };
}

function readReveal(data: unknown): ArenaReveal | null {
  const record = asRecord(data);
  const models = asRecord(record?.models);
  const a = asRecord(models?.A);
  const b = asRecord(models?.B);
  if (!(record && a && b) || typeof record.vote !== "string") {
    return null;
  }
  return {
    models: {
      A: { displayName: String(a.displayName ?? "Model A") },
      B: { displayName: String(b.displayName ?? "Model B") },
    },
    vote: record.vote as ArenaVote,
  };
}

/**
 * Fold an assistant message's parts back into one matchup. Slot B arrives as
 * one `data-arena-b-delta` part per token while streaming and as a single
 * compacted part when replayed from the database, so both are concatenated.
 */
export function readArenaMatchup(
  message: Pick<ChatMessage, "parts" | "role">,
): ArenaMatchupView | null {
  if (message.role !== "assistant") {
    return null;
  }

  const parts = (message.parts ?? []) as UnknownPart[];
  let meta: ArenaMeta | null = null;
  let reveal: ArenaReveal | null = null;
  let slotA = "";
  let slotB = "";
  let slotBDone = false;
  const errors: ArenaSlotError[] = [];

  for (const part of parts) {
    switch (part.type) {
      case "text":
        slotA += part.text ?? "";
        break;
      case "data-arena-meta":
        meta = readMeta(part.data) ?? meta;
        break;
      case "data-arena-b-delta": {
        const record = asRecord(part.data);
        slotB += typeof record?.text === "string" ? record.text : "";
        break;
      }
      case "data-arena-b-done":
        slotBDone = true;
        break;
      case "data-arena-error": {
        const record = asRecord(part.data);
        if (record && typeof record.message === "string") {
          errors.push({
            message: record.message,
            slot: record.slot === "B" ? "B" : "A",
          });
        }
        break;
      }
      case "data-arena-reveal":
        reveal = readReveal(part.data) ?? reveal;
        break;
      default:
        break;
    }
  }

  if (!meta) {
    return null;
  }

  const mode = meta.mode ?? "matchup";
  return {
    errors,
    meta,
    mode,
    reveal,
    slotA,
    slotB,
    slotBDone,
    // A round with nothing to vote on carries no token at all. `votable` is
    // authoritative when the server provides it.
    votable: meta.votable ?? (mode === "matchup" && Boolean(meta.matchupToken)),
  };
}
