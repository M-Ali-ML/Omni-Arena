import { useCallback, useState } from "react";
import type { ArenaReveal, ArenaVote } from "./protocol.js";
import { submitArenaVote } from "./vote.js";

export interface UseArenaVoteOptions {
  /** Origin (or path prefix) the arena API is served from (default `""`). */
  baseUrl?: string;
  /** The round to vote on; a `vote()` call may override both. */
  matchupId?: string;
  /** null on a round with nothing to vote on, which makes `canVote` false. */
  matchupToken?: string | null;
}

export interface ArenaVoteTarget {
  matchupId: string;
  matchupToken: string;
}

/**
 * A vote button's worth of state around {@link submitArenaVote}, for host apps
 * whose own runtime owns the messages and only needs the reveal. Resolves to
 * null on failure with the message in `error`, so a click handler needs no
 * try/catch.
 */
export function useArenaVote(options: UseArenaVoteOptions = {}) {
  const { baseUrl = "", matchupId, matchupToken } = options;
  const [reveal, setReveal] = useState<ArenaReveal | null>(null);
  const [isVoting, setIsVoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vote = useCallback(
    async (
      choice: ArenaVote,
      target?: ArenaVoteTarget,
    ): Promise<ArenaReveal | null> => {
      const id = target?.matchupId ?? matchupId;
      const token = target?.matchupToken ?? matchupToken;
      if (!id || !token) {
        setError("This round cannot be voted on");
        return null;
      }
      setIsVoting(true);
      setError(null);
      try {
        const result = await submitArenaVote({
          matchupId: id,
          matchupToken: token,
          vote: choice,
          baseUrl,
        });
        setReveal(result);
        return result;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Vote failed");
        return null;
      } finally {
        setIsVoting(false);
      }
    },
    [baseUrl, matchupId, matchupToken],
  );

  const reset = useCallback((): void => {
    setReveal(null);
    setError(null);
    setIsVoting(false);
  }, []);

  return {
    vote,
    reset,
    reveal,
    isVoting,
    error,
    canVote: Boolean(matchupId && matchupToken) && !reveal,
  };
}
