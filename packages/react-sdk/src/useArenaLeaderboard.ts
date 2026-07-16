import { useCallback, useEffect, useState } from "react";

export interface LeaderboardModel {
  id: string;
  displayName: string;
  wins: number;
  losses: number;
  ties: number;
  skips: number;
  totalVotes: number;
  winRate: number;
  // Bradley-Terry rating from the Python worker; null until it has run.
  rating: number | null;
  ratingStdError: number | null;
  confidenceInterval: { lower: number; upper: number } | null;
  componentId: number | null;
  // Style-controlled rating (verbosity/formatting/latency/position regressed
  // out jointly) from the worker's heavier style pass; null until it has run.
  styleControlledRating: number | null;
  styleControlledStdError: number | null;
  styleControlledConfidenceInterval: { lower: number; upper: number } | null;
}

export interface UseArenaLeaderboardOptions {
  /**
   * Origin (or path prefix) the arena API is served from, e.g.
   * `https://arena.example.com`. Defaults to "" so requests hit the
   * same-origin `/api/arena/leaderboard` route the demo app proxies.
   */
  baseUrl?: string;
}

export function useArenaLeaderboard(options: UseArenaLeaderboardOptions = {}) {
  const { baseUrl = "" } = options;
  const [models, setModels] = useState<LeaderboardModel[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`${baseUrl}/api/arena/leaderboard`);
      if (!response.ok) {
        throw new Error(`Leaderboard failed (${response.status})`);
      }
      const payload = (await response.json()) as {
        models: LeaderboardModel[];
      };
      setModels(payload.models);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Leaderboard unavailable",
      );
    }
  }, [baseUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { models, refresh, error };
}
