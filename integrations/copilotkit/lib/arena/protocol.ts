/**
 * OmniArena wire helpers beside the CopilotKit AG-UI runtime.
 *
 * Parsing / session / vote POSTs come from `@omni-arena/react`. What remains
 * here is host-specific: the matchup response header, conversation
 * rehydration (not in the SDK), message-id → slot mapping, and vote labels.
 */
import {
  getSessionId as sdkGetSessionId,
  isArenaSlot,
  isArenaVote,
  parseArenaMatchup as sdkParseArenaMatchup,
  parseArenaReveal,
  submitArenaVote,
  type ArenaMatchupInfo,
  type ArenaMode,
  type ArenaSlot,
  type ArenaVote,
  type RevealedModel,
} from "@omni-arena/react";

export type { ArenaSlot, ArenaMode, ArenaVote };
export type VoteChoice = ArenaVote;

export const MATCHUP_HEADER = "x-arena-matchup";

export type ArenaMatchup = {
  matchupId: string;
  matchupToken?: string;
  slots: ArenaSlot[];
  mode: ArenaMode;
  votable: boolean;
  conversationId?: string;
  turnIndex?: number;
};

export type ArenaReveal = Record<ArenaSlot, RevealedModel>;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function toHostMatchup(info: ArenaMatchupInfo): ArenaMatchup {
  return {
    matchupId: info.matchupId,
    ...(info.matchupToken ? { matchupToken: info.matchupToken } : {}),
    slots: info.slots,
    mode: info.mode,
    votable: info.votable,
    ...(info.conversationId ? { conversationId: info.conversationId } : {}),
    ...(typeof info.turnIndex === "number" ? { turnIndex: info.turnIndex } : {}),
  };
}

export function parseArenaMatchup(value: unknown): ArenaMatchup | null {
  const info = sdkParseArenaMatchup(value);
  return info ? toHostMatchup(info) : null;
}

export function parseMatchupHeader(raw: string | null): ArenaMatchup | null {
  if (!raw) return null;
  try {
    return parseArenaMatchup(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** `<matchupId>:<slot>` is the normative slot-identity channel. */
export function parseSlotMessageId(
  messageId: string,
): { matchupId: string; slot: ArenaSlot } | null {
  const separator = messageId.lastIndexOf(":");
  if (separator <= 0) return null;
  const slot = messageId.slice(separator + 1);
  if (!isArenaSlot(slot)) return null;
  return { matchupId: messageId.slice(0, separator), slot };
}

export function getSessionId(): string {
  if (typeof window === "undefined") return "copilotkit-ssr";
  return sdkGetSessionId({
    key: "omni-arena.sessionId",
    prefix: "copilotkit-",
  });
}

export async function postVote(body: {
  matchupId: string;
  matchupToken: string;
  vote: VoteChoice;
}): Promise<{ ok: true; result: VoteResult } | { ok: false; error: string }> {
  try {
    const reveal = await submitArenaVote(body);
    return {
      ok: true,
      result: {
        models: reveal.models,
        continuable: reveal.continuable,
        ...(reveal.conversationId
          ? { conversationId: reveal.conversationId }
          : {}),
      },
    };
  } catch (caught) {
    return {
      ok: false,
      error: caught instanceof Error ? caught.message : "Vote failed",
    };
  }
}

export function parseRevealModels(value: unknown): ArenaReveal | null {
  const reveal = parseArenaReveal({ models: value });
  return reveal ? reveal.models : null;
}

function parseTurn(value: unknown): ConversationTurn | null {
  if (!isRecord(value)) return null;
  if (typeof value.matchupId !== "string" || typeof value.prompt !== "string") {
    return null;
  }
  const answers = Array.isArray(value.answers)
    ? value.answers.flatMap((entry) => {
        if (!isRecord(entry) || !isArenaSlot(entry.slot)) return [];
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
    vote: isArenaVote(value.vote) ? value.vote : null,
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
  const payload: unknown = await response.json().catch(() => ({}));
  const record =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  if (!response.ok) {
    return {
      ok: false,
      error:
        typeof record.error === "string"
          ? record.error
          : `Conversation fetch failed (${response.status})`,
    };
  }
  const conversation = parseConversation(payload);
  if (!conversation) {
    return { ok: false, error: "Malformed conversation payload" };
  }
  return { ok: true, conversation };
}
