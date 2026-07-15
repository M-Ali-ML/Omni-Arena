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
}

export function useArenaLeaderboard() {
  const [models, setModels] = useState<LeaderboardModel[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/arena/leaderboard");
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
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { models, refresh, error };
}
