/**
 * The arena wire contract, framework-free.
 *
 * Nothing here touches React, the DOM, or a network client, so a host app can
 * type and parse arena traffic from a server route, an edge function, or its
 * own adapter (`?protocol=vercel-ai`, AG-UI, A2UI) instead of only from the
 * batteries-included `useArenaChat` hook.
 */
export type ArenaSlot = "A" | "B";

export type ArenaVote =
  | "left"
  | "right"
  | "both_good"
  | "both_bad"
  | "skip";

/** How the server ran the round: `single` rounds are not votable. */
export type ArenaMode = "matchup" | "single" | "shadow";

export interface RevealedModel {
  id: string;
  displayName: string;
}

export interface ArenaReveal {
  models: Record<ArenaSlot, RevealedModel>;
  /** The vote the reveal was granted for; null when it was not carried. */
  vote: ArenaVote | null;
  /**
   * Whether the next turn may continue this conversation. The server states it
   * on the vote response; against one that predates the field it is derived
   * from the vote, which is the rule every host used to encode by hand.
   */
  continuable: boolean;
  /** The conversation to continue with, when the response carried it. */
  conversationId?: string;
}

export interface ArenaSlotError {
  slot: ArenaSlot;
  message: string;
}

export type ArenaStreamEventType =
  | "matchup_started"
  | "token"
  | "slot_error"
  | "slot_done"
  | "run_error"
  | "matchup_done";

/**
 * One `data:` payload of the native SSE protocol. `matchupToken`,
 * `conversationId`, and `turnIndex` are omitted entirely on a round the server
 * neither persisted nor accepts votes for, so every identifier is optional and
 * `matchupId` is the only one always present.
 */
export interface ArenaStreamEvent {
  type: ArenaStreamEventType;
  code?: string;
  matchupId?: string;
  matchupToken?: string;
  conversationId?: string;
  turnIndex?: number;
  slots?: ArenaSlot[];
  mode?: ArenaMode;
  votable?: boolean;
  slot?: ArenaSlot;
  token?: string;
  message?: string;
}

/** A `matchup_started` event normalised into the handles a host needs. */
export interface ArenaMatchupInfo {
  matchupId: string;
  /** null on a round with nothing to vote on; older servers sent `""`. */
  matchupToken: string | null;
  /**
   * Absent on a round the server persisted nothing for, which is how it says
   * there is no conversation to continue — sending one back anyway answers 404.
   */
  conversationId?: string;
  turnIndex?: number;
  slots: ArenaSlot[];
  mode: ArenaMode;
  votable: boolean;
}

export const ARENA_VOTE_VALUES: readonly ArenaVote[] = [
  "left",
  "right",
  "both_good",
  "both_bad",
  "skip",
];

export function isArenaSlot(value: unknown): value is ArenaSlot {
  return value === "A" || value === "B";
}

export function isArenaVote(value: unknown): value is ArenaVote {
  return ARENA_VOTE_VALUES.includes(value as ArenaVote);
}

/** Only a decisive vote leaves a winning response the next turn continues from. */
export function isDecisiveVote(vote: ArenaVote): boolean {
  return vote === "left" || vote === "right";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read a matchup out of whatever shape the round arrived in: the native
 * `matchup_started` event, AG-UI's `arena_matchup` custom value, or the
 * `data-arena-meta` part of a UI message stream all carry the same fields.
 * Returns null when there is no `matchupId`, i.e. it is not a matchup at all.
 */
export function parseArenaMatchup(value: unknown): ArenaMatchupInfo | null {
  const record = asRecord(value);
  if (!record || typeof record.matchupId !== "string") {
    return null;
  }
  const slots = Array.isArray(record.slots)
    ? record.slots.filter(isArenaSlot)
    : [];
  return {
    matchupId: record.matchupId,
    matchupToken:
      typeof record.matchupToken === "string" && record.matchupToken !== ""
        ? record.matchupToken
        : null,
    ...(typeof record.conversationId === "string"
      ? { conversationId: record.conversationId }
      : {}),
    ...(typeof record.turnIndex === "number"
      ? { turnIndex: record.turnIndex }
      : {}),
    slots: slots.length > 0 ? slots : ["A", "B"],
    mode:
      record.mode === "single" || record.mode === "shadow"
        ? record.mode
        : "matchup",
    // Defaulted to true so rounds from servers that predate arena modes (which
    // omit the field) still expose voting.
    votable: typeof record.votable === "boolean" ? record.votable : true,
  };
}

function parseRevealedModel(value: unknown): RevealedModel | null {
  const record = asRecord(value);
  if (!record || typeof record.displayName !== "string") {
    return null;
  }
  return {
    id: typeof record.id === "string" ? record.id : record.displayName,
    displayName: record.displayName,
  };
}

/**
 * Read a reveal out of a vote response (`{ accepted, models }`) or an adapter's
 * reveal part. Both slots must be present: a half-reveal would let a UI show
 * one identity while still claiming the round is blind.
 */
export function parseArenaReveal(value: unknown): ArenaReveal | null {
  const record = asRecord(value);
  const models = asRecord(record?.models);
  const a = parseRevealedModel(models?.A);
  const b = parseRevealedModel(models?.B);
  if (!a || !b) {
    return null;
  }
  const vote = isArenaVote(record?.vote) ? record.vote : null;
  return {
    models: { A: a, B: b },
    vote,
    continuable:
      typeof record?.continuable === "boolean"
        ? record.continuable
        : vote !== null && isDecisiveVote(vote),
    ...(typeof record?.conversationId === "string"
      ? { conversationId: record.conversationId }
      : {}),
  };
}

export function parseArenaSlotError(value: unknown): ArenaSlotError | null {
  const record = asRecord(value);
  if (!record || !isArenaSlot(record.slot)) {
    return null;
  }
  return {
    slot: record.slot,
    message: typeof record.message === "string" ? record.message : "Slot failed",
  };
}
