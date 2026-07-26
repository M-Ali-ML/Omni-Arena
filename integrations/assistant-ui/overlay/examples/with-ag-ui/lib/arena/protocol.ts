/**
 * OmniArena wire helpers used beside the stock AG-UI runtime.
 *
 * Matchup metadata for voting no longer depends on `CUSTOM arena_matchup` —
 * mainstream runtimes drop that event. The same payload rides
 * `x-arena-matchup` on the chat response (and can be re-read from
 * `GET /api/arena/matchups/:id` without the token).
 */
export type ArenaSlot = "A" | "B";
export type ArenaMode = "matchup" | "single" | "shadow";
export type VoteChoice = "left" | "right" | "both_good" | "both_bad" | "skip";

export const MATCHUP_HEADER = "x-arena-matchup";

export type ArenaMatchup = {
  matchupId: string;
  /** Absent on a non-votable (`single`) round — the arena mints no token there. */
  matchupToken?: string;
  slots: ArenaSlot[];
  mode: ArenaMode;
  votable: boolean;
  /**
   * Absent on a round the arena persisted nothing for, which is its way of
   * saying there is no conversation to continue.
   */
  conversationId?: string;
  turnIndex?: number;
};

export type ArenaSlotError = { slot: ArenaSlot; message: string };

export type ArenaReveal = Record<ArenaSlot, { id: string; displayName: string }>;

export type VoteResult = {
  models: ArenaReveal;
  continuable: boolean;
  conversationId?: string;
};

export type ConversationTurn = {
  turnIndex: number;
  matchupId: string;
  prompt: string;
  votable: boolean;
  vote: VoteChoice | null;
  answers: { slot: ArenaSlot; content: string; error: string | null }[];
  models: ArenaReveal | null;
};

export type ConversationSnapshot = {
  conversationId: string;
  continuable: boolean;
  nextTurnIndex: number;
  turns: ConversationTurn[];
};

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

const isVote = (value: unknown): value is VoteChoice =>
  value === "left" ||
  value === "right" ||
  value === "both_good" ||
  value === "both_bad" ||
  value === "skip";

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

export function parseMatchupHeader(raw: string | null): ArenaMatchup | null {
  if (!raw) return null;
  try {
    return parseArenaMatchup(JSON.parse(raw));
  } catch {
    return null;
  }
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

function parseRevealModels(value: unknown): ArenaReveal | null {
  if (!isRecord(value)) return null;
  const a = isRecord(value.A) ? value.A : null;
  const b = isRecord(value.B) ? value.B : null;
  if (
    !a ||
    !b ||
    typeof a.displayName !== "string" ||
    typeof b.displayName !== "string"
  ) {
    return null;
  }
  return {
    A: {
      id: typeof a.id === "string" ? a.id : a.displayName,
      displayName: a.displayName,
    },
    B: {
      id: typeof b.id === "string" ? b.id : b.displayName,
      displayName: b.displayName,
    },
  };
}

export async function postVote(body: {
  matchupId: string;
  matchupToken: string;
  vote: VoteChoice;
}): Promise<{ ok: true; result: VoteResult } | { ok: false; error: string }> {
  const response = await fetch("/api/arena/vote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const models = parseRevealModels(payload.models);
  if (!response.ok || !models) {
    return {
      ok: false,
      error:
        typeof payload.error === "string"
          ? payload.error
          : `Vote failed (${response.status})`,
    };
  }
  return {
    ok: true,
    result: {
      models,
      // Prefer the server's own flag; fall back to the decisive-vote rule for
      // older responses that predate `continuable`.
      continuable:
        typeof payload.continuable === "boolean"
          ? payload.continuable
          : isDecisive(body.vote),
      ...(typeof payload.conversationId === "string"
        ? { conversationId: payload.conversationId }
        : {}),
    },
  };
}

function parseTurn(value: unknown): ConversationTurn | null {
  if (!isRecord(value)) return null;
  if (typeof value.matchupId !== "string" || typeof value.prompt !== "string") {
    return null;
  }
  const answers = Array.isArray(value.answers)
    ? value.answers.flatMap((entry) => {
        if (!isRecord(entry) || !isSlot(entry.slot)) return [];
        return [
          {
            slot: entry.slot,
            content: typeof entry.content === "string" ? entry.content : "",
            error: typeof entry.error === "string" ? entry.error : null,
          },
        ];
      })
    : [];
  return {
    turnIndex: typeof value.turnIndex === "number" ? value.turnIndex : 0,
    matchupId: value.matchupId,
    prompt: value.prompt,
    votable: value.votable === true,
    vote: isVote(value.vote) ? value.vote : null,
    answers,
    models: parseRevealModels(value.models),
  };
}

export function parseConversation(value: unknown): ConversationSnapshot | null {
  if (!isRecord(value) || typeof value.conversationId !== "string") return null;
  const turns = Array.isArray(value.turns)
    ? value.turns.flatMap((turn) => {
        const parsed = parseTurn(turn);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    conversationId: value.conversationId,
    continuable: value.continuable === true,
    nextTurnIndex:
      typeof value.nextTurnIndex === "number" ? value.nextTurnIndex : turns.length,
    turns,
  };
}

export async function fetchConversation(
  conversationId: string,
): Promise<
  | { ok: true; conversation: ConversationSnapshot }
  | { ok: false; error: string }
> {
  const sessionId = getSessionId();
  const response = await fetch(
    `/api/arena/conversations/${encodeURIComponent(conversationId)}?sessionId=${encodeURIComponent(sessionId)}`,
  );
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    return {
      ok: false,
      error:
        typeof payload.error === "string"
          ? payload.error
          : `Conversation fetch failed (${response.status})`,
    };
  }
  const conversation = parseConversation(payload);
  if (!conversation) {
    return { ok: false, error: "Malformed conversation payload" };
  }
  return { ok: true, conversation };
}
