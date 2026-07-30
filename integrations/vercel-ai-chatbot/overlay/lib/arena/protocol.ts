/**
 * The OmniArena side of the wire, expressed in this app's types.
 *
 * Parsing and vote/matchup normalisation come from `@omni-arena/react`. This
 * module only adapts those primitives to the AI SDK UI Message Stream shape
 * this host persists and renders: slot A on `text`, slot B on `data-arena-*`.
 */
import {
  isDecisiveVote,
  parseArenaMatchup,
  parseArenaReveal,
  parseArenaSlotError,
  type ArenaMode,
  type ArenaSlot,
  type ArenaSlotError,
  type ArenaVote,
} from "@omni-arena/react";
import type { ChatMessage } from "@/lib/types";

export type { ArenaMode, ArenaSlot, ArenaSlotError, ArenaVote };
export { isDecisiveVote };

/** Response header the arena mirrors onto every chat response. */
export const MATCHUP_HEADER = "x-arena-matchup";

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

export type ArenaRevealedModel = { id?: string; displayName: string };

export type ArenaReveal = {
  vote: ArenaVote;
  models: Record<ArenaSlot, ArenaRevealedModel>;
  continuable?: boolean;
  conversationId?: string;
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

type UnknownPart = { type: string; data?: unknown; text?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Map an SDK matchup (native event, `data-arena-meta`, or `x-arena-matchup`)
 * onto the meta shape this host stores on assistant messages.
 */
export function arenaMetaFromUnknown(value: unknown): ArenaMeta | null {
  const parsed = parseArenaMatchup(value);
  if (!parsed) {
    return null;
  }
  const record = asRecord(value);
  return {
    ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
    dataSlot: "B",
    mainSlot: "A",
    matchupId: parsed.matchupId,
    ...(parsed.matchupToken ? { matchupToken: parsed.matchupToken } : {}),
    mode: parsed.mode,
    ...(typeof parsed.turnIndex === "number" ? { turnIndex: parsed.turnIndex } : {}),
    // Keep absent-vs-boolean so callers can apply the host votable rule below;
    // the SDK defaults missing `votable` to true for older servers.
    votable: typeof record?.votable === "boolean" ? record.votable : undefined,
  };
}

/** Parse the `x-arena-matchup` response header. */
export function parseMatchupHeader(raw: string | null): ArenaMeta | null {
  if (!raw) {
    return null;
  }
  try {
    return arenaMetaFromUnknown(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function arenaRevealFromUnknown(value: unknown): ArenaReveal | null {
  const parsed = parseArenaReveal(value);
  if (!parsed?.vote) {
    return null;
  }
  return {
    models: {
      A: {
        displayName: parsed.models.A.displayName,
        ...(parsed.models.A.id ? { id: parsed.models.A.id } : {}),
      },
      B: {
        displayName: parsed.models.B.displayName,
        ...(parsed.models.B.id ? { id: parsed.models.B.id } : {}),
      },
    },
    vote: parsed.vote,
    continuable: parsed.continuable,
    ...(parsed.conversationId ? { conversationId: parsed.conversationId } : {}),
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
        meta = arenaMetaFromUnknown(part.data) ?? meta;
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
        const error = parseArenaSlotError(part.data);
        if (error) {
          errors.push(error);
        }
        break;
      }
      case "data-arena-reveal":
        reveal = arenaRevealFromUnknown(part.data) ?? reveal;
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
