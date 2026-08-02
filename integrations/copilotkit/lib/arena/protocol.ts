/**
 * OmniArena wire helpers beside the CopilotKit AG-UI runtime.
 *
 * Parsing / session / vote POSTs come from `@omni-arena/react`. What remains
 * here is host-specific: the matchup response header, message-id → slot
 * mapping, and vote labels.
 */
import {
  getSessionId as sdkGetSessionId,
  isArenaSlot,
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

export const VOTE_OPTIONS: { choice: VoteChoice; label: string }[] = [
  { choice: "left", label: "A is better" },
  { choice: "right", label: "B is better" },
  { choice: "both_good", label: "Both good" },
  { choice: "both_bad", label: "Both bad" },
  { choice: "skip", label: "Skip" },
];

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
