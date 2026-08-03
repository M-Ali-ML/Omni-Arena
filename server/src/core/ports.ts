import type { ArenaSlot } from "./events.js";

export interface ChatMessage {
  /**
   * `system` carries mid-stream operator steer instructions (identical on both
   * slots). Providers without a system role map it to `user`.
   */
  role: "user" | "assistant" | "system";
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

/** Persisted exposure of a matchup row: human-votable blind vs silent shadow. */
export type MatchupMode = "blind" | "shadow";

export interface MatchupRecord {
  id: string;
  prompt: string;
  modelAId: string;
  modelBId: string;
  slotAModelId: string;
  slotBModelId: string;
  /** Provider model id for slot A at insert time (survives roster repoints). */
  slotAProviderModelId: string;
  /** Provider model id for slot B at insert time (survives roster repoints). */
  slotBProviderModelId: string;
  matchupTokenHash: string;
  harnessVersion: string;
  /** `blind` (default) is votable; `shadow` is persisted but not votable. */
  mode: MatchupMode;
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

/** Minimal model reference: the pair a reveal and the analytics payloads name. */
export interface ModelRef {
  id: string;
  displayName: string;
}

/**
 * A persisted matchup read back after its stream is over — what a client that
 * reloaded, or one whose runtime dropped the metadata event, needs to recover
 * the round. `vote` is null while the round is still open; the identities are
 * only ever disclosed against a recorded vote (see `routes/reveal.ts`).
 */
export interface MatchupView {
  id: string;
  matchupTokenHash: string;
  conversationId: string;
  turnIndex: number;
  slotA: Model;
  slotB: Model;
  vote: ArenaVote | null;
  /** `shadow` rows reject human votes; `blind` is the default votable path. */
  mode: MatchupMode;
}

/** One completed or in-flight turn of a conversation, both slots included. */
export interface ConversationTurn {
  turnIndex: number;
  matchupId: string;
  prompt: string;
  /** The blind answers by slot. Absent for a slot whose response never landed. */
  answers: Array<{ slot: ArenaSlot; content: string; error: string | null }>;
  vote: ArenaVote | null;
  slotA: Model;
  slotB: Model;
}

export interface PreferenceRepositoryPort {
  listEnabledModels(): Promise<Model[]>;
  createMatchup(matchup: MatchupRecord): Promise<void>;
  saveResponse(response: ResponseRecord): Promise<void>;
  /**
   * Append a mid-stream steer instruction to the matchup so later analysis can
   * control for operator interventions. No-op when the matchup is unknown.
   */
  recordSteer(matchupId: string, instruction: string): Promise<void>;
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
  getMatchup(matchupId: string): Promise<MatchupView | null>;
  /**
   * Every turn of one conversation, for a client rebuilding a thread after a
   * reload. Scoped to the anonymous session that owns the conversation, since
   * this is the one read that returns prompts and answers rather than
   * model-level aggregates.
   */
  getConversationTurns(
    conversationId: string,
    anonymousSessionId: string | null,
  ): Promise<
    | { status: "ready"; conversationId: string; turns: ConversationTurn[] }
    | { status: "not_found" }
    | { status: "forbidden" }
  >;
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

/**
 * How the fitted style effect below should be read. The worker z-scales the
 * continuous covariates before fitting, so their coefficients are per standard
 * deviation of the vote-level delta; `position` is a constant covariate and its
 * coefficient is therefore the absolute left-slot advantage.
 */
export type StyleEffectBasis = "absolute" | "per_std_dev";

/**
 * One style confounder from the worker's joint Bradley-Terry regression
 * (docs/md/rating-methodology.md), restated on the leaderboard's display scale so a reader can
 * compare it against a rating gap.
 */
export interface StyleEffect {
  /** Worker feature name: `position`, `verbosity`, `formatting`, `latency_*`. */
  feature: string;
  /** The fitted coefficient exactly as stored, in log-odds. */
  logOdds: number;
  /** `logOdds` in display rating points — read it per `basis`. */
  points: number;
  basis: StyleEffectBasis;
  /**
   * The same effect per interpretable amount of the raw feature (e.g. 100
   * output tokens). Null for `position`, which has no underlying unit, and
   * whenever the deltas carry no spread to un-standardise with.
   */
  perUnit: { points: number; unit: string } | null;
}

/**
 * The fitted style confounders, plus the sample the per-unit restatement was
 * derived from. Empty until the worker's style pass has run.
 */
export interface StyleControlReport {
  effects: StyleEffect[];
  /**
   * Votes whose style deltas backed the per-unit conversion. Zero means only
   * the per-standard-deviation reading is available.
   */
  votesObserved: number;
  /** When the worker last wrote these coefficients; null when it never has. */
  computedAt: string | null;
}

/**
 * Connectivity of the comparison graph. Bradley-Terry ratings are only
 * identified up to a per-component constant (docs/md/rating-methodology.md
 * §Identifiability), so a client must not
 * compare ratings across components.
 */
export interface LeaderboardComponents {
  /** Components spanned by the rated roster; null before the worker has run. */
  count: number | null;
  /** Rated models per component, ascending by component id. */
  groups: Array<{ componentId: number; models: number }>;
}

/**
 * Everything needed to read the leaderboard's ratings honestly: whether they
 * are mutually comparable at all, and how much of a gap superficial style buys.
 */
export interface RatingContext {
  components: LeaderboardComponents;
  styleControl: StyleControlReport;
}

export interface LeaderboardPort {
  getLeaderboard(): Promise<LeaderboardEntry[]>;
  getRatingContext(): Promise<RatingContext>;
}

/** Minimal model reference shared by the analytics payloads. */
export type AnalyticsModelRef = ModelRef;

/** Arena-wide aggregates for the insights dashboard's summary strip. */
export interface ArenaSummary {
  totalMatchups: number;
  totalVotes: number;
  decisiveVotes: number;
  tieVotes: number;
  skipVotes: number;
  /** Decisive votes won by the model shown in UI slot A vs slot B. */
  slotAWins: number;
  slotBWins: number;
  enabledModels: number;
  /** Distinct canonical model pairs with at least one non-skip vote. */
  pairsSampled: number;
  /** n·(n−1)/2 over the enabled roster. */
  pairsPossible: number;
  /**
   * Number of connected components in the comparison graph per the rating
   * worker, or null before it has run.
   */
  ratingComponents: number | null;
}

/** Vote record for one canonical (unordered) model pair. */
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

/**
 * Per-model response-style and position statistics. Latency/verbosity fields
 * are null until the model has at least one error-free response.
 */
export interface ModelMetricsEntry extends AnalyticsModelRef {
  responses: number;
  ttftMsP50: number | null;
  ttftMsP90: number | null;
  durationMsP50: number | null;
  durationMsP90: number | null;
  meanOutputTokens: number | null;
  meanMarkdownDensity: number | null;
  /** Decisive-vote record split by which UI slot the model occupied. */
  slotAWins: number;
  slotAGames: number;
  slotBWins: number;
  slotBGames: number;
}

export type ActivityBucketSize = "day" | "hour";

export interface ActivityVoteBucket {
  /** ISO timestamp of the bucket start (UTC). */
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
  /** Model id → cumulative non-skip games at the end of this bucket. */
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
  /** Models the worker has rated in both the raw and style-controlled pass. */
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

export interface AnalyticsPort {
  getSummary(): Promise<ArenaSummary>;
  getHeadToHead(): Promise<HeadToHeadStats>;
  getModelMetrics(): Promise<ModelMetricsEntry[]>;
  getActivity(bucket: ActivityBucketSize): Promise<ActivityStats>;
  getStyleControl(): Promise<StyleControlStats>;
  getRatingHistory(since: Date | null): Promise<RatingHistoryStats>;
}
