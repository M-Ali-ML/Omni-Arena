"use client";

import { useCallback, useSyncExternalStore } from "react";
import { isDecisiveVote } from "@omni-arena/react";
import {
  clearPersistedArena,
  persistConversationId,
  persistMatchupToken,
  persistThreadId,
  readPersistedArena,
} from "./persistence";
import type {
  ArenaMatchup,
  ArenaReveal,
  ArenaSlot,
  ConversationSnapshot,
  VoteChoice,
  VoteResult,
} from "./protocol";

/**
 * Arena state CopilotKit has nowhere to put: matchup metadata (vote token,
 * mode, reveal) lives beside the thread, keyed by matchup id recoverable from
 * any slot message id (`<matchupId>:A`).
 */
export type MatchupState = ArenaMatchup & {
  slotOrder: ArenaSlot[];
  vote: VoteChoice | null;
  reveal: ArenaReveal | null;
  continuable: boolean | null;
  voting: boolean;
  voteError: string | null;
};

export type ThreadState = {
  arenaEnabled: boolean;
  conversationId: string | null;
  matchupIds: string[];
  runError: string | null;
  /** CopilotKit thread id — used to poll the server-side matchup cache. */
  threadId: string;
};

export type ArenaState = {
  thread: ThreadState;
  matchups: Record<string, MatchupState>;
};

const EMPTY_THREAD: ThreadState = {
  arenaEnabled: true,
  conversationId: null,
  matchupIds: [],
  runError: null,
  threadId: "",
};

let state: ArenaState = { thread: EMPTY_THREAD, matchups: {} };
const listeners = new Set<() => void>();

const emit = (next: ArenaState): void => {
  state = next;
  for (const listener of listeners) listener();
};

const patchThread = (patch: Partial<ThreadState>): void => {
  emit({ ...state, thread: { ...state.thread, ...patch } });
};

const patchMatchup = (matchupId: string, patch: Partial<MatchupState>): void => {
  const current = state.matchups[matchupId];
  if (!current) return;
  emit({
    ...state,
    matchups: { ...state.matchups, [matchupId]: { ...current, ...patch } },
  });
};

const rememberConversation = (conversationId: string | null): void => {
  persistConversationId(conversationId);
};

export const arenaStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getSnapshot(): ArenaState {
    return state;
  },

  setThreadId(threadId: string): void {
    if (state.thread.threadId === threadId) return;
    persistThreadId(threadId);
    patchThread({ threadId });
  },

  setArenaEnabled(arenaEnabled: boolean): void {
    patchThread({
      arenaEnabled,
      ...(arenaEnabled ? {} : { conversationId: null }),
    });
    if (!arenaEnabled) rememberConversation(null);
  },

  beginMatchup(matchup: ArenaMatchup): void {
    const existing = state.matchups[matchup.matchupId];
    // A hydrated (or already-voted) round must not be reset by a stale
    // matchup-cache poll — that wipe is what made reload lose reveals.
    if (existing?.vote != null || existing?.reveal) {
      return;
    }
    const persistedToken = readPersistedArena().tokens[matchup.matchupId];
    const withToken: ArenaMatchup = {
      ...matchup,
      ...(matchup.matchupToken
        ? {}
        : persistedToken
          ? { matchupToken: persistedToken }
          : {}),
    };
    if (withToken.matchupToken) {
      persistMatchupToken(withToken.matchupId, withToken.matchupToken);
    }
    if (withToken.conversationId) {
      rememberConversation(withToken.conversationId);
    }
    emit({
      thread: {
        ...state.thread,
        runError: null,
        ...(withToken.conversationId
          ? { conversationId: withToken.conversationId }
          : {}),
        matchupIds: state.thread.matchupIds.includes(withToken.matchupId)
          ? state.thread.matchupIds
          : [...state.thread.matchupIds, withToken.matchupId],
      },
      matchups: {
        ...state.matchups,
        [withToken.matchupId]: {
          ...withToken,
          slotOrder: [...withToken.slots],
          vote: null,
          reveal: null,
          continuable: null,
          voting: false,
          voteError: null,
        },
      },
    });
  },

  noteRunError(message: string): void {
    patchThread({ runError: message });
  },

  setVoting(matchupId: string, voting: boolean): void {
    patchMatchup(matchupId, { voting, voteError: null });
  },

  recordVote(matchupId: string, vote: VoteChoice, result: VoteResult): void {
    const current = state.matchups[matchupId];
    if (current) {
      const { matchupToken: _spent, ...rest } = current;
      emit({
        ...state,
        matchups: {
          ...state.matchups,
          [matchupId]: {
            ...rest,
            vote,
            reveal: result.models,
            continuable: result.continuable,
            voting: false,
            voteError: null,
          },
        },
      });
    }
    persistMatchupToken(matchupId, undefined);
    if (result.continuable) {
      const conversationId =
        result.conversationId ??
        state.matchups[matchupId]?.conversationId ??
        null;
      patchThread({ conversationId });
      rememberConversation(conversationId);
    } else {
      patchThread({ conversationId: null });
      rememberConversation(null);
    }
  },

  failVote(matchupId: string, error: string): void {
    patchMatchup(matchupId, { voting: false, voteError: error });
  },

  /**
   * Rebuild matchup/reveal state from `GET /api/arena/conversations/:id`.
   * Tokens for a still-votable last turn come from local persistence — the
   * read endpoint never returns them.
   */
  hydrateConversation(conversation: ConversationSnapshot): void {
    const tokens = readPersistedArena().tokens;
    const matchups: Record<string, MatchupState> = { ...state.matchups };
    const matchupIds: string[] = [];
    for (const turn of conversation.turns) {
      matchupIds.push(turn.matchupId);
      const slots = turn.answers.map((answer) => answer.slot);
      const token = turn.votable ? tokens[turn.matchupId] : undefined;
      matchups[turn.matchupId] = {
        matchupId: turn.matchupId,
        ...(token ? { matchupToken: token } : {}),
        slots: slots.length > 0 ? slots : ["A", "B"],
        mode: "matchup",
        votable: turn.votable,
        conversationId: conversation.conversationId,
        turnIndex: turn.turnIndex,
        slotOrder: slots.length > 0 ? slots : ["A", "B"],
        vote: turn.vote,
        reveal: turn.models,
        continuable: turn.vote ? isDecisiveVote(turn.vote) : null,
        voting: false,
        voteError: null,
      };
    }
    // Keep the server id in persistence even when the thread is not yet
    // continuable — another reload must still rebuild an unvoted last round.
    persistConversationId(conversation.conversationId);
    emit({
      thread: {
        ...state.thread,
        conversationId: conversation.continuable
          ? conversation.conversationId
          : null,
        matchupIds,
        runError: null,
      },
      matchups,
    });
  },

  resetConversation(): void {
    const threadId = state.thread.threadId;
    clearPersistedArena();
    if (threadId) persistThreadId(threadId);
    patchThread({ conversationId: null, runError: null, matchupIds: [] });
  },
};

export function useArenaState<T>(selector: (snapshot: ArenaState) => T): T {
  const select = useCallback(
    () => selector(arenaStore.getSnapshot()),
    [selector],
  );
  return useSyncExternalStore(arenaStore.subscribe, select, select);
}

export function useArenaThread(): ThreadState {
  return useArenaState((s) => s.thread);
}

export function useMatchup(matchupId: string | null): MatchupState | null {
  const selector = useCallback(
    (snapshot: ArenaState) =>
      matchupId ? (snapshot.matchups[matchupId] ?? null) : null,
    [matchupId],
  );
  return useArenaState(selector);
}
