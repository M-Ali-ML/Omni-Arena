"use client";

import { postVote, VOTE_OPTIONS, type VoteChoice } from "@/lib/arena/protocol";
import { arenaStore, useMatchup } from "@/lib/arena/store";

/**
 * Blind five-way vote + inline reveal. Hidden when the round is not votable
 * (`mode: "single"`). Continuation copy follows the server's `continuable`
 * flag rather than re-encoding left|right locally.
 */
export function ArenaVoteBar({
  matchupId,
  isRunning,
}: {
  matchupId: string | null;
  isRunning: boolean;
}) {
  const matchup = useMatchup(matchupId);

  if (!matchup) return null;

  const voted = matchup.vote !== null;
  const matchupToken = matchup.matchupToken;

  // After a vote the five-way row is gone; only the reveal strip remains.
  // `arena-vote-bar` stays reserved for the active vote controls so
  // `getByTestId(VOTE_BAR)` is absent on non-votable / already-voted rounds.
  if (voted && matchup.reveal) {
    return (
      <div className="arena-vote-bar">
        <p data-testid="arena-reveal" className="arena-reveal">
          Revealed — A was <strong>{matchup.reveal.A.displayName}</strong>, B
          was <strong>{matchup.reveal.B.displayName}</strong>.{" "}
          {matchup.continuable ? (
            <span data-testid="arena-can-continue">
              Your next message continues turn {(matchup.turnIndex ?? 0) + 2}{" "}
              from the winning response.
            </span>
          ) : (
            <span>
              No single winner, so the next message starts a fresh conversation.
            </span>
          )}
        </p>
      </div>
    );
  }

  // Contract: vote bar absent when not votable — only the explanation shows.
  if (!matchup.votable || !matchupToken) {
    return !matchup.votable ? (
      <p data-testid="arena-not-votable" className="arena-not-votable">
        Single-model round ({matchup.mode}) — the arena marked it{" "}
        <code>votable: false</code>, so there is nothing to vote on.
      </p>
    ) : null;
  }

  const cast = async (vote: VoteChoice): Promise<void> => {
    arenaStore.setVoting(matchup.matchupId, true);
    const outcome = await postVote({
      matchupId: matchup.matchupId,
      matchupToken,
      vote,
    });
    if (outcome.ok) {
      arenaStore.recordVote(matchup.matchupId, vote, outcome.result);
    } else {
      arenaStore.failVote(matchup.matchupId, outcome.error);
    }
  };

  return (
    <div data-testid="arena-vote-bar" className="arena-vote-bar">
      <div className="arena-vote-row">
        <span className="arena-vote-hint">
          {isRunning ? "Streaming both answers…" : "Which answer is better?"}
        </span>
        {VOTE_OPTIONS.map((option) => (
          <button
            key={option.choice}
            type="button"
            className="arena-vote-btn"
            data-testid={`arena-vote-${option.choice}`}
            disabled={isRunning || matchup.voting}
            onClick={() => void cast(option.choice)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {matchup.voteError && (
        <p data-testid="arena-vote-error" className="arena-error">
          {matchup.voteError}
        </p>
      )}
    </div>
  );
}
