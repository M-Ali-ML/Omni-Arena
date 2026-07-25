"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  isDecisive,
  type ArenaMatchup,
  type ArenaReveal,
  type ArenaSlot,
  type VoteChoice,
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
  /** Slots in TEXT_MESSAGE_START order; index i is the i-th assistant text part. */
  slotOrder: ArenaSlot[];
  errors: Partial<Record<ArenaSlot, string>>;
  vote: VoteChoice | null;
  reveal: ArenaReveal | null;
  voting: boolean;
  voteError: string | null;
};

export type ThreadState = {
  /** Whether the next turn opts into a matchup (`x-arena: on`). */
  arenaEnabled: boolean;
  /** Set after a decisive vote; the arena continues from the winning response. */
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
  },

  /** `CUSTOM arena_matchup` — the first thing every arena round emits. */
  beginMatchup(threadId: string, matchup: ArenaMatchup): void {
    const thread = threadOf(state, threadId);
    emit({
      ...state,
      threads: {
        ...state.threads,
        [threadId]: {
          ...thread,
          runError: null,
          matchupIds: thread.matchupIds.includes(matchup.matchupId)
            ? thread.matchupIds
            : [...thread.matchupIds, matchup.matchupId],
        },
      },
      matchups: {
        ...state.matchups,
        [matchup.matchupId]: {
          ...matchup,
          slotOrder: [],
          errors: {},
          vote: null,
          reveal: null,
          voting: false,
          voteError: null,
        },
      },
    });
  },

  /**
   * `TEXT_MESSAGE_START` — records which slot owns which assistant text part.
   * assistant-ui's AG-UI runtime folds both slot messages into one assistant
   * message and drops the adapter's `slot` field, so part order is the only
   * surviving link between a column and a slot.
   */
  noteSlotStart(matchupId: string, slot: ArenaSlot): void {
    const current = state.matchups[matchupId];
    if (!current || current.slotOrder.includes(slot)) return;
    patchMatchup(matchupId, { slotOrder: [...current.slotOrder, slot] });
  },

  /** `CUSTOM slot_error` — one slot failed; the other keeps streaming. */
  noteSlotError(matchupId: string, slot: ArenaSlot, message: string): void {
    const current = state.matchups[matchupId];
    if (!current) return;
    patchMatchup(matchupId, { errors: { ...current.errors, [slot]: message } });
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
    reveal: ArenaReveal,
  ): void {
    const matchup = state.matchups[matchupId];
    patchMatchup(matchupId, { vote, reveal, voting: false, voteError: null });
    if (!matchup) return;
    patchThread(
      threadId,
      isDecisive(vote)
        ? {
            // A round with no conversation id has nothing to continue from.
            conversationId: matchup.conversationId ?? null,
            continuedFrom: { matchupId, slot: vote === "left" ? "A" : "B" },
          }
        : // Tie / both-bad / skip leaves no winning response, so OmniArena
          // cannot continue this conversation — the next turn starts a new one.
          { conversationId: null, continuedFrom: null },
    );
  },

  failVote(matchupId: string, error: string): void {
    patchMatchup(matchupId, { voting: false, voteError: error });
  },

  resetThread(threadId: string): void {
    patchThread(threadId, {
      conversationId: null,
      continuedFrom: null,
      runError: null,
      matchupIds: [],
    });
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
