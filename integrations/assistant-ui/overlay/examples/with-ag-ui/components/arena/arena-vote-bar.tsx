"use client";

import { Button } from "@/components/ui/button";
import { postVote, VOTE_OPTIONS, type VoteChoice } from "@/lib/arena/protocol";
import { arenaStore, useActiveThreadId, useMatchup } from "@/lib/arena/store";
import type { FC } from "react";

/**
 * The blind vote, and the reveal that follows it.
 *
 * Hidden entirely when the round is not votable — OmniArena marks a
 * single-model round `votable: false` and mints no token for it, so there is
 * nothing to vote on. Continuation copy follows the server's `continuable`
 * flag from the vote response rather than re-encoding left|right locally.
 */
export const ArenaVoteBar: FC<{
  matchupId: string | null;
  isRunning: boolean;
}> = ({ matchupId, isRunning }) => {
  const matchup = useMatchup(matchupId);
  const threadId = useActiveThreadId();

  if (!matchup) return null;

  const voted = matchup.vote !== null;
  const matchupToken = matchup.matchupToken;

  if (voted && matchup.reveal) {
    return (
      <div data-testid="arena-vote-bar" className="mt-3 flex flex-col gap-2">
        <p data-testid="arena-reveal" className="text-sm">
          <span className="text-muted-foreground">Revealed — </span>
          A was <strong>{matchup.reveal.A.displayName}</strong>, B was{" "}
          <strong>{matchup.reveal.B.displayName}</strong>.{" "}
          {matchup.continuable ? (
            <span
              data-testid="arena-can-continue"
              className="text-muted-foreground"
            >
              Your next message continues turn {(matchup.turnIndex ?? 0) + 2}{" "}
              from the winning response.
            </span>
          ) : (
            <span className="text-muted-foreground">
              No single winner, so the next message starts a fresh conversation.
            </span>
          )}
        </p>
      </div>
    );
  }

  if (!matchup.votable || !matchupToken) {
    return !matchup.votable ? (
      <p
        data-testid="arena-not-votable"
        className="text-muted-foreground mt-3 text-xs"
      >
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
      arenaStore.recordVote(threadId, matchup.matchupId, vote, outcome.result);
    } else {
      arenaStore.failVote(matchup.matchupId, outcome.error);
    }
  };

  return (
    <div data-testid="arena-vote-bar" className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground mr-1 text-xs">
          {isRunning ? "Streaming both answers…" : "Which answer is better?"}
        </span>
        {VOTE_OPTIONS.map((option) => (
          <Button
            key={option.choice}
            type="button"
            size="sm"
            variant="outline"
            data-testid={`arena-vote-${option.choice}`}
            disabled={isRunning || matchup.voting}
            onClick={() => void cast(option.choice)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {matchup.voteError && (
        <p data-testid="arena-vote-error" className="text-destructive text-sm">
          {matchup.voteError}
        </p>
      )}
    </div>
  );
};
