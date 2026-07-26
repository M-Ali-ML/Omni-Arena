import type { ArenaVote, Model, ModelRef } from "../core/ports.js";

/**
 * What a recorded vote unlocks. Both rules below were previously re-derived by
 * every client — the reveal by whoever held the vote response, and
 * "`left|right` ⇒ continuable" by hand in each integration — which is why a
 * host that guessed wrong got a `409` mid-conversation instead of an answer.
 */

/** Both slots' identities, as a client renders them after a vote. */
export interface Reveal {
  A: ModelRef;
  B: ModelRef;
}

export function revealOf(slotA: Model, slotB: Model): Reveal {
  return {
    A: { id: slotA.id, displayName: slotA.displayName },
    B: { id: slotB.id, displayName: slotB.displayName },
  };
}

/**
 * Identities are the one thing the arena hides, and a recorded vote is the only
 * thing that discloses them: a reader who could name the models of an open
 * round could vote the label instead of the answer. Every read path goes
 * through here so that rule is enforced in one place rather than per route.
 */
export function revealIfVoted(matchup: {
  vote: ArenaVote | null;
  slotA: Model;
  slotB: Model;
}): Reveal | null {
  return matchup.vote === null
    ? null
    : revealOf(matchup.slotA, matchup.slotB);
}

/**
 * Whether the turn this vote settled can be continued. Only a decisive vote
 * leaves a single winning response for the next turn to build on; a tie, a
 * both-bad, a skip, or no vote at all leaves the conversation with no agreed
 * history, which the chat route refuses with `conversation_not_ready`.
 */
export function isContinuable(vote: ArenaVote | null): boolean {
  return vote === "left" || vote === "right";
}
