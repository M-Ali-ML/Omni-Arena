"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  clearPersistedArena,
  persistConversationId,
  persistMatchupToken,
  readPersistedArena,
} from "./persistence";
import { isDecisiveVote } from "@omni-arena/react";
import {
  type ArenaMatchup,
  type ArenaReveal,
  type ArenaSlot,
  type ConversationSnapshot,
  type VoteChoice,
  type VoteResult,
} from "./protocol";

/**
 * Arena state that assistant-ui has nowhere to put.
 *
 * The AG-UI runtime models a run as one assistant message with N text parts, so
 * the matchup metadata (vote token, mode, slot order, reveal) has to live
 * beside the thread. Keyed by matchup id — which is recoverable from any
 * assistant message id (`<matchupId>:A`) — so history keeps its own reveal
 * instead of only the latest round having one.
 */
export type MatchupState = ArenaMatchup & {
  /** Slots in stream / answer order; index i is the i-th assistant text part. */
  slotOrder: ArenaSlot[];
  errors: Partial<Record<ArenaSlot, string>>;
  vote: VoteChoice | null;
  reveal: ArenaReveal | null;
  /** Server's answer after a vote; null until one lands. */
  continuable: boolean | null;
  voting: boolean;
  voteError: string | null;
};

export type ThreadState = {
  /** Whether the next turn opts into a matchup (`x-arena: on`). */
  arenaEnabled: boolean;
  /** Set after a continuable vote; the arena continues from the winning response. */
  conversationId: string | null;
  continuedFrom: { matchupId: string; slot: ArenaSlot } | null;
  matchupIds: string[];
  runError: string | null;
};

export type ArenaState = {
  /**
   * The thread the arena agent is currently bound to. assistant-ui exposes its
   * own thread id, but the arena agent is the thing that owns the mapping to an
   * OmniArena conversation, so this is the id the vote UI trusts.
   */
  activeThreadId: string;
  threads: Record<string, ThreadState>;
  matchups: Record<string, MatchupState>;
};

const EMPTY_THREAD: ThreadState = {
  arenaEnabled: true,
  conversationId: null,
  continuedFrom: null,
  matchupIds: [],
  runError: null,
};

let state: ArenaState = { activeThreadId: "", threads: {}, matchups: {} };
const listeners = new Set<() => void>();

const emit = (next: ArenaState): void => {
  state = next;
  for (const listener of listeners) listener();
};

const threadOf = (snapshot: ArenaState, threadId: string): ThreadState =>
  snapshot.threads[threadId] ?? EMPTY_THREAD;

const patchThread = (threadId: string, patch: Partial<ThreadState>): void => {
  emit({
    ...state,
    threads: {
      ...state.threads,
      [threadId]: { ...threadOf(state, threadId), ...patch },
    },
  });
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
    return () => listeners.delete(listener);
  },

  getSnapshot(): ArenaState {
    return state;
  },

  getThread(threadId: string): ThreadState {
    return threadOf(state, threadId);
  },

  setActiveThread(threadId: string): void {
    if (state.activeThreadId === threadId) return;
    emit({ ...state, activeThreadId: threadId });
  },

  setArenaEnabled(threadId: string, arenaEnabled: boolean): void {
    patchThread(threadId, {
      arenaEnabled,
      // A single-model turn is not part of an arena conversation, and the arena
      // refuses to continue one anyway, so drop the continuation handle.
      ...(arenaEnabled ? {} : { conversationId: null, continuedFrom: null }),
    });
    if (!arenaEnabled) rememberConversation(null);
  },

  /**
   * Matchup metadata from `x-arena-matchup` (or a conversation hydrate). Slot
   * order defaults to the advertised `slots` list — the AG-UI adapter starts
   * messages in that order.
   */
  beginMatchup(threadId: string, matchup: ArenaMatchup): void {
    const thread = threadOf(state, threadId);
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
      ...state,
      threads: {
        ...state.threads,
        [threadId]: {
          ...thread,
          runError: null,
          ...(withToken.conversationId
            ? { conversationId: withToken.conversationId }
            : {}),
          matchupIds: thread.matchupIds.includes(withToken.matchupId)
            ? thread.matchupIds
            : [...thread.matchupIds, withToken.matchupId],
        },
      },
      matchups: {
        ...state.matchups,
        [withToken.matchupId]: {
          ...withToken,
          slotOrder: [...withToken.slots],
          errors: {},
          vote: null,
          reveal: null,
          continuable: null,
          voting: false,
          voteError: null,
        },
      },
    });
  },

  noteRunError(threadId: string, message: string): void {
    patchThread(threadId, { runError: message });
  },

  setVoting(matchupId: string, voting: boolean): void {
    patchMatchup(matchupId, { voting, voteError: null });
  },

  recordVote(
    threadId: string,
    matchupId: string,
    vote: VoteChoice,
    result: VoteResult,
  ): void {
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
      patchThread(threadId, {
        conversationId,
        continuedFrom: { matchupId, slot: vote === "left" ? "A" : "B" },
      });
      rememberConversation(conversationId);
    } else {
      patchThread(threadId, { conversationId: null, continuedFrom: null });
      rememberConversation(null);
    }
  },

  failVote(matchupId: string, error: string): void {
    patchMatchup(matchupId, { voting: false, voteError: error });
  },

  /**
   * Rebuild matchup/reveal state from `GET /api/arena/conversations/:id`. Tokens
   * for a still-votable last turn come from local persistence — the read
   * endpoint never returns them.
   */
  hydrateConversation(threadId: string, conversation: ConversationSnapshot): void {
    const tokens = readPersistedArena().tokens;
    const matchups: Record<string, MatchupState> = { ...state.matchups };
    const matchupIds: string[] = [];
    for (const turn of conversation.turns) {
      matchupIds.push(turn.matchupId);
      const slots = turn.answers.map((answer) => answer.slot);
      const errors: Partial<Record<ArenaSlot, string>> = {};
      for (const answer of turn.answers) {
        if (answer.error) errors[answer.slot] = answer.error;
      }
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
        errors,
        vote: turn.vote,
        reveal: turn.models,
        continuable: turn.vote ? isDecisiveVote(turn.vote) : null,
        voting: false,
        voteError: null,
      };
    }
    const conversationId = conversation.continuable
      ? conversation.conversationId
      : null;
    rememberConversation(conversationId);
    emit({
      ...state,
      threads: {
        ...state.threads,
        [threadId]: {
          ...threadOf(state, threadId),
          conversationId,
          continuedFrom: null,
          matchupIds,
          runError: null,
        },
      },
      matchups,
    });
  },

  resetThread(threadId: string): void {
    patchThread(threadId, {
      conversationId: null,
      continuedFrom: null,
      runError: null,
      matchupIds: [],
    });
    clearPersistedArena();
  },
};

export function useArenaState<T>(selector: (snapshot: ArenaState) => T): T {
  const select = useCallback(() => selector(arenaStore.getSnapshot()), [selector]);
  return useSyncExternalStore(arenaStore.subscribe, select, select);
}

export function useActiveThreadId(): string {
  return useArenaState(selectActiveThreadId);
}

const selectActiveThreadId = (snapshot: ArenaState): string =>
  snapshot.activeThreadId;

export function useArenaThread(threadId: string): ThreadState {
  const selector = useCallback(
    (snapshot: ArenaState) => threadOf(snapshot, threadId),
    [threadId],
  );
  return useArenaState(selector);
}

export function useMatchup(matchupId: string | null): MatchupState | null {
  const selector = useCallback(
    (snapshot: ArenaState) =>
      matchupId ? (snapshot.matchups[matchupId] ?? null) : null,
    [matchupId],
  );
  return useArenaState(selector);
}
