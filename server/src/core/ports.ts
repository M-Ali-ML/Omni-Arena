import type { ArenaSlot } from "./events.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type ModelStreamChunk =
  | { type: "token"; token: string }
  | {
      type: "metadata";
      modelVersion?: string;
      outputTokenCount?: number;
    };

export type ArenaVote =
  | "left"
  | "right"
  | "both_good"
  | "both_bad"
  | "skip";

export interface Model {
  id: string;
  displayName: string;
  provider: string;
  providerModelId: string;
  enabled: boolean;
}

export interface ModelProviderPort {
  stream(model: Model, messages: ChatMessage[]): AsyncIterable<ModelStreamChunk>;
}

export interface ProviderResolverPort {
  resolve(provider: string): ModelProviderPort;
}

export interface MatchupAssignment {
  modelA: Model;
  modelB: Model;
  slotA: Model;
  slotB: Model;
}

export interface MatchmakingPort {
  pick(): Promise<MatchupAssignment>;
}

/** Games played by a canonical (unordered) model pair. */
export interface PairSampleCount {
  modelAId: string;
  modelBId: string;
  games: number;
}

/**
 * Inputs the smart matchmaker needs to prioritise informative matchups:
 * the enabled roster, how many decided games each pair already has, and each
 * model's rating-interval width (its uncertainty). Absent uncertainty means the
 * worker has not rated that model yet.
 */
export interface MatchmakingStats {
  models: Model[];
  pairGames: PairSampleCount[];
  ratingUncertainty: Record<string, number>;
}

export interface MatchmakingStatsPort {
  getMatchmakingStats(): Promise<MatchmakingStats>;
}

export interface MatchupRecord {
  id: string;
  prompt: string;
  modelAId: string;
  modelBId: string;
  slotAModelId: string;
  slotBModelId: string;
  matchupTokenHash: string;
  harnessVersion: string;
  conversation: {
    id: string;
    turnId: string;
    turnIndex: number;
    parentResponseId: string | null;
    anonymousSessionId: string | null;
  };
}

export interface ResponseRecord {
  matchupId: string;
  slot: ArenaSlot;
  modelId: string;
  content: string;
  latencyMs: number;
  ttftMs: number | null;
  streamDurationMs: number;
  outputTokenCount: number;
  tokenCountSource: "provider" | "estimated";
  markdownDensity: number;
  modelVersion: string | null;
  error: string | null;
}

export interface PreferenceRecord {
  matchupId: string;
  vote: ArenaVote;
  winnerModelId: string | null;
  positionBiasMeta: Record<string, unknown>;
  anonymousSessionId: string | null;
}

export interface PreferenceRepositoryPort {
  listEnabledModels(): Promise<Model[]>;
  createMatchup(matchup: MatchupRecord): Promise<void>;
  saveResponse(response: ResponseRecord): Promise<void>;
  recordPreference(preference: PreferenceRecord): Promise<void>;
  getConversationContext(
    conversationId: string,
    anonymousSessionId: string | null,
  ): Promise<
    | {
        status: "ready";
        conversationId: string;
        nextTurnIndex: number;
        parentResponseId: string;
        messages: ChatMessage[];
      }
    | { status: "not_found" }
    | { status: "forbidden" }
    | { status: "not_ready" }
  >;
  getMatchup(matchupId: string): Promise<{
    id: string;
    matchupTokenHash: string;
    slotA: Model;
    slotB: Model;
  } | null>;
}

export interface RatingInterval {
  lower: number;
  upper: number;
}

export interface LeaderboardEntry {
  id: string;
  displayName: string;
  wins: number;
  losses: number;
  ties: number;
  skips: number;
  totalVotes: number;
  winRate: number;
  /**
   * Bradley-Terry rating (Elo-like scale) from the Python worker, or null when
   * the worker has not yet rated this model. The win-rate fields above are
   * always present regardless.
   */
  rating: number | null;
  ratingStdError: number | null;
  confidenceInterval: RatingInterval | null;
  /**
   * Connected-component id of the comparison graph. Ratings are only
   * comparable within the same component; null until the worker has run.
   */
  componentId: number | null;
  /**
   * Style-controlled Bradley-Terry rating: the model's strength with verbosity,
   * formatting, latency, and position confounders regressed out jointly. From
   * the worker's heavier periodic style pass; null until that pass has run.
   */
  styleControlledRating: number | null;
  styleControlledStdError: number | null;
  styleControlledConfidenceInterval: RatingInterval | null;
}

export interface LeaderboardPort {
  getLeaderboard(): Promise<LeaderboardEntry[]>;
}
