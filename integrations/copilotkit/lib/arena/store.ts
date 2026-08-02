"use client";

import { useCallback, useSyncExternalStore } from "react";
import type {
  ArenaMatchup,
  ArenaReveal,
  ArenaSlot,
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
    patchThread({ threadId });
  },

  setArenaEnabled(arenaEnabled: boolean): void {
    patchThread({
      arenaEnabled,
      ...(arenaEnabled ? {} : { conversationId: null }),
    });
  },

  beginMatchup(matchup: ArenaMatchup): void {
    emit({
      thread: {
        ...state.thread,
        runError: null,
        ...(matchup.conversationId
          ? { conversationId: matchup.conversationId }
          : {}),
        matchupIds: state.thread.matchupIds.includes(matchup.matchupId)
          ? state.thread.matchupIds
          : [...state.thread.matchupIds, matchup.matchupId],
      },
      matchups: {
        ...state.matchups,
        [matchup.matchupId]: {
          ...matchup,
          slotOrder: [...matchup.slots],
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
    if (result.continuable) {
      const conversationId =
        result.conversationId ??
        state.matchups[matchupId]?.conversationId ??
        null;
      patchThread({ conversationId });
    } else {
      patchThread({ conversationId: null });
    }
  },

  failVote(matchupId: string, error: string): void {
    patchMatchup(matchupId, { voting: false, voteError: error });
  },

  resetConversation(): void {
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
