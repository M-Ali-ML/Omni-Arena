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

/**
 * A style confounder from the worker's joint Bradley-Terry fit, on the same
 * display scale as `rating`. Read `points` per `basis`: `absolute` effects
 * (the left-slot advantage) stand alone, `per_std_dev` ones are per standard
 * deviation of the vote-level delta. `perUnit` restates the same effect per
 * readable amount of the raw feature and is null when that cannot be derived.
 */
export interface StyleEffect {
  feature: string;
  logOdds: number;
  points: number;
  basis: "absolute" | "per_std_dev";
  perUnit: { points: number; unit: string } | null;
}

export interface StyleControlReport {
  effects: StyleEffect[];
  votesObserved: number;
  computedAt: string | null;
}

/**
 * Connectivity of the comparison graph. Ratings are only identified up to a
 * per-component constant, so they must not be compared across components.
 * `count` is null until the rating worker has run.
 */
export interface LeaderboardComponents {
  count: number | null;
  groups: Array<{ componentId: number; models: number }>;
}

const noComponents: LeaderboardComponents = { count: null, groups: [] };
const noStyleControl: StyleControlReport = {
  effects: [],
  votesObserved: 0,
  computedAt: null,
};

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
  const [components, setComponents] =
    useState<LeaderboardComponents>(noComponents);
  const [styleControl, setStyleControl] =
    useState<StyleControlReport>(noStyleControl);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`${baseUrl}/api/arena/leaderboard`);
      if (!response.ok) {
        throw new Error(`Leaderboard failed (${response.status})`);
      }
      // Both context fields are optional on the wire so the hook keeps working
      // against servers that predate them.
      const payload = (await response.json()) as {
        models: LeaderboardModel[];
        components?: LeaderboardComponents;
        styleControl?: StyleControlReport;
      };
      setModels(payload.models);
      setComponents(payload.components ?? noComponents);
      setStyleControl(payload.styleControl ?? noStyleControl);
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

  return { models, components, styleControl, refresh, error };
}
