import { useCallback, useEffect, useState } from "react";

// Types mirror the server's /api/arena/analytics/* contracts by convention
// (the SDK deliberately has no compile-time dependency on the server).

export interface AnalyticsModelRef {
  id: string;
  displayName: string;
}

export interface ArenaSummary {
  totalMatchups: number;
  totalVotes: number;
  decisiveVotes: number;
  tieVotes: number;
  skipVotes: number;
  slotAWins: number;
  slotBWins: number;
  enabledModels: number;
  pairsSampled: number;
  pairsPossible: number;
  ratingComponents: number | null;
}

export interface HeadToHeadPair {
  modelAId: string;
  modelBId: string;
  aWins: number;
  bWins: number;
  ties: number;
  games: number;
}

export interface HeadToHeadStats {
  models: AnalyticsModelRef[];
  pairs: HeadToHeadPair[];
}

export interface ModelMetricsEntry extends AnalyticsModelRef {
  responses: number;
  ttftMsP50: number | null;
  ttftMsP90: number | null;
  durationMsP50: number | null;
  durationMsP90: number | null;
  meanOutputTokens: number | null;
  meanMarkdownDensity: number | null;
  slotAWins: number;
  slotAGames: number;
  slotBWins: number;
  slotBGames: number;
}

export type ActivityBucketSize = "day" | "hour";

export interface ActivityVoteBucket {
  bucketStart: string;
  left: number;
  right: number;
  bothGood: number;
  bothBad: number;
  skip: number;
  total: number;
}

export interface ActivityCumulativeBucket {
  bucketStart: string;
  games: Record<string, number>;
}

export interface ActivityStats {
  bucket: ActivityBucketSize;
  models: AnalyticsModelRef[];
  votes: ActivityVoteBucket[];
  cumulativeGames: ActivityCumulativeBucket[];
}

export interface StyleCoefficient {
  feature: string;
  coefficient: number;
  computedAt: string;
}

export interface StyleControlStats {
  coefficients: StyleCoefficient[];
  models: Array<
    AnalyticsModelRef & { rating: number; styleControlledRating: number }
  >;
}

export interface RatingHistoryPoint {
  modelId: string;
  rating: number;
  ciLower: number;
  ciUpper: number;
  games: number;
  computedAt: string;
}

export interface RatingHistoryStats {
  models: AnalyticsModelRef[];
  points: RatingHistoryPoint[];
}

export interface UseArenaAnalyticsOptions {
  /**
   * Origin (or path prefix) the arena API is served from. Defaults to "" so
   * requests hit the same-origin /api/arena/analytics/* routes.
   */
  baseUrl?: string;
}

export interface AnalyticsResource<T> {
  data: T | null;
  refresh: () => Promise<void>;
  error: string | null;
}

function useAnalyticsResource<T>(path: string, baseUrl: string): AnalyticsResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`${baseUrl}${path}`);
      if (!response.ok) {
        throw new Error(`Analytics request failed (${response.status})`);
      }
      setData((await response.json()) as T);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Analytics unavailable",
      );
    }
  }, [baseUrl, path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, refresh, error };
}

export function useArenaSummary(options: UseArenaAnalyticsOptions = {}) {
  return useAnalyticsResource<ArenaSummary>(
    "/api/arena/analytics/summary",
    options.baseUrl ?? "",
  );
}

export function useArenaHeadToHead(options: UseArenaAnalyticsOptions = {}) {
  return useAnalyticsResource<HeadToHeadStats>(
    "/api/arena/analytics/head-to-head",
    options.baseUrl ?? "",
  );
}

export function useArenaModelMetrics(options: UseArenaAnalyticsOptions = {}) {
  return useAnalyticsResource<{ models: ModelMetricsEntry[] }>(
    "/api/arena/analytics/model-metrics",
    options.baseUrl ?? "",
  );
}

export interface UseArenaActivityOptions extends UseArenaAnalyticsOptions {
  bucket?: ActivityBucketSize;
}

export function useArenaActivity(options: UseArenaActivityOptions = {}) {
  return useAnalyticsResource<ActivityStats>(
    `/api/arena/analytics/activity?bucket=${options.bucket ?? "day"}`,
    options.baseUrl ?? "",
  );
}

export function useArenaStyleControl(options: UseArenaAnalyticsOptions = {}) {
  return useAnalyticsResource<StyleControlStats>(
    "/api/arena/analytics/style-control",
    options.baseUrl ?? "",
  );
}

export interface UseArenaRatingHistoryOptions extends UseArenaAnalyticsOptions {
  /** ISO 8601 timestamp; only snapshots at or after this instant are returned. */
  since?: string;
}

export function useArenaRatingHistory(
  options: UseArenaRatingHistoryOptions = {},
) {
  const query = options.since
    ? `?since=${encodeURIComponent(options.since)}`
    : "";
  return useAnalyticsResource<RatingHistoryStats>(
    `/api/arena/analytics/rating-history${query}`,
    options.baseUrl ?? "",
  );
}
