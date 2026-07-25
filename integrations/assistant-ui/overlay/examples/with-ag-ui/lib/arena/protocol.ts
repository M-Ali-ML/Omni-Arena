/**
 * The OmniArena side of the wire, as it arrives over AG-UI.
 *
 * OmniArena frames one blind matchup as two concurrent AG-UI text messages in a
 * single run (`<matchupId>:A` / `<matchupId>:B`) and puts everything the AG-UI
 * taxonomy has no field for — matchup id, signed vote token, trigger mode — in
 * a `CUSTOM` event named `arena_matchup`. These parsers are deliberately
 * defensive: `CUSTOM.value` is typed `any` by the AG-UI schema, so nothing here
 * may assume a shape.
 */
export type ArenaSlot = "A" | "B";
export type ArenaMode = "matchup" | "single" | "shadow";
export type VoteChoice = "left" | "right" | "both_good" | "both_bad" | "skip";

export type ArenaMatchup = {
  matchupId: string;
  /** Absent on a non-votable (`single`) round — the arena mints no token there. */
  matchupToken?: string;
  slots: ArenaSlot[];
  mode: ArenaMode;
  votable: boolean;
  /**
   * Absent on a round the arena persisted nothing for, which is its way of
   * saying there is no conversation to continue. Sending one back anyway used
   * to earn a `404 Conversation not found`.
   */
  conversationId?: string;
  turnIndex?: number;
};

export type ArenaSlotError = { slot: ArenaSlot; message: string };

export type ArenaReveal = Record<ArenaSlot, { id: string; displayName: string }>;

export const VOTE_OPTIONS: { choice: VoteChoice; label: string }[] = [
  { choice: "left", label: "A is better" },
  { choice: "right", label: "B is better" },
  { choice: "both_good", label: "Both good" },
  { choice: "both_bad", label: "Both bad" },
  { choice: "skip", label: "Skip" },
];

/** Only a decisive vote leaves a winning response the next turn can continue from. */
export const isDecisive = (vote: VoteChoice): boolean =>
  vote === "left" || vote === "right";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isSlot = (value: unknown): value is ArenaSlot =>
  value === "A" || value === "B";

export function parseArenaMatchup(value: unknown): ArenaMatchup | null {
  if (!isRecord(value)) return null;
  const {
    matchupId,
    matchupToken,
    slots,
    mode,
    votable,
    conversationId,
    turnIndex,
  } = value;
  if (typeof matchupId !== "string") {
    return null;
  }
  return {
    matchupId,
    // An older arena sent `""` for "no token"; both spellings mean the same.
    ...(typeof matchupToken === "string" && matchupToken.length > 0
      ? { matchupToken }
      : {}),
    slots: Array.isArray(slots) ? slots.filter(isSlot) : ["A", "B"],
    mode:
      mode === "single" || mode === "shadow" || mode === "matchup"
        ? mode
        : "matchup",
    votable: votable === true,
    ...(typeof conversationId === "string" ? { conversationId } : {}),
    ...(typeof turnIndex === "number" ? { turnIndex } : {}),
  };
}

export function parseSlotError(value: unknown): ArenaSlotError | null {
  if (!isRecord(value)) return null;
  const { slot, message } = value;
  if (!isSlot(slot)) return null;
  return { slot, message: typeof message === "string" ? message : "Slot failed" };
}

/** `<matchupId>:<slot>` is the only place the slot identity survives into assistant-ui. */
export function matchupIdFromMessageId(messageId: string): string | null {
  const separator = messageId.lastIndexOf(":");
  if (separator <= 0) return null;
  const slot = messageId.slice(separator + 1);
  return isSlot(slot) ? messageId.slice(0, separator) : null;
}

const SESSION_STORAGE_KEY = "omni-arena.sessionId";

/**
 * A stable anonymous session id. OmniArena ties conversation ownership to it,
 * so a follow-up turn must present the same one that started the conversation.
 */
export function getSessionId(): string {
  if (typeof window === "undefined") return "assistant-ui-ssr";
  const existing = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) return existing;
  const created = `assistant-ui-${crypto.randomUUID()}`;
  window.localStorage.setItem(SESSION_STORAGE_KEY, created);
  return created;
}

export async function postVote(body: {
  matchupId: string;
  matchupToken: string;
  vote: VoteChoice;
}): Promise<{ ok: true; models: ArenaReveal } | { ok: false; error: string }> {
  const response = await fetch("/api/arena/vote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    models?: ArenaReveal;
    error?: string;
  };
  if (!response.ok || !payload.models) {
    return { ok: false, error: payload.error ?? `Vote failed (${response.status})` };
  }
  return { ok: true, models: payload.models };
}
