import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ArenaSlot } from "../core/events.js";
import type {
  ActivityBucketSize,
  ActivityCumulativeBucket,
  ActivityStats,
  ActivityVoteBucket,
  AnalyticsPort,
  ArenaSummary,
  ArenaVote,
  ChatMessage,
  ConversationTurn,
  HeadToHeadPair,
  HeadToHeadStats,
  LeaderboardComponents,
  LeaderboardEntry,
  LeaderboardPort,
  MatchmakingStats,
  MatchmakingStatsPort,
  MatchupRecord,
  MatchupView,
  Model,
  ModelMetricsEntry,
  PreferenceRecord,
  PreferenceRepositoryPort,
  RatingContext,
  RatingHistoryStats,
  ResponseRecord,
  StyleControlReport,
  StyleControlStats,
  StyleEffect,
} from "../core/ports.js";

interface ModelRow {
  id: string;
  display_name: string;
  provider: string;
  provider_model_id: string;
  enabled: boolean;
}

/**
 * Log-odds to display points, the scale the rating worker publishes ratings on
 * (`SCALE` in `worker/omniarena_rating/report.py`). Style coefficients go
 * through it too so a confounder's worth is quoted in the same currency as the
 * rating gaps it is competing with.
 */
const DISPLAY_SCALE = 400 / Math.LN10;

/**
 * Covariates the worker fits as a constant rather than a per-vote delta, so
 * their coefficient is already an absolute effect. `position` is the leading
 * 1.0 column, hence exactly the left-slot advantage.
 */
const ABSOLUTE_STYLE_FEATURES = new Set(["position"]);

/**
 * A readable denominator per continuous feature, in the raw units the worker
 * differenced: `output_token_count`, the 0..1 `markdown_density` fraction, and
 * milliseconds.
 */
const STYLE_FEATURE_UNITS: Record<string, { size: number; unit: string }> = {
  verbosity: { size: 100, unit: "100 output tokens" },
  formatting: { size: 0.1, unit: "0.1 markdown density" },
  latency_ttft: { size: 100, unit: "100 ms of TTFT" },
  latency_duration: { size: 1000, unit: "second of streaming" },
};

/** Presentation order, following `FEATURE_NAMES` in the worker's `style.py`. */
const STYLE_FEATURE_ORDER = [
  "position",
  "verbosity",
  "formatting",
  "latency_ttft",
  "latency_duration",
];

/**
 * Population standard deviation from SQL-side sums, matching the numpy `.std()`
 * the worker standardises its covariates with. Null when the deltas carry no
 * spread — the same `std > 1e-12` floor `style.py` uses, below which it leaves
 * the column unscaled and no raw-unit scale can be recovered.
 */
function stdDevFromSums(
  sum: number,
  squareSum: number,
  count: number,
): number | null {
  if (count === 0) {
    return null;
  }
  const variance = squareSum / count - (sum / count) ** 2;
  return variance > 1e-24 ? Math.sqrt(variance) : null;
}

function mapModel(row: ModelRow): Model {
  return {
    id: row.id,
    displayName: row.display_name,
    provider: row.provider,
    providerModelId: row.provider_model_id,
    enabled: row.enabled,
  };
}

export class DuplicateVoteError extends Error {
  constructor() {
    super("A vote has already been recorded for this matchup");
  }
}

export class ConversationConflictError extends Error {
  constructor() {
    super("The conversation has already advanced from this response");
  }
}

/**
 * Linear-interpolation percentile over a pre-sorted ascending array.
 * Percentiles are computed in TypeScript rather than SQL because pg-mem
 * (used by the integration tests) does not implement percentile_cont.
 */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const position = (sorted.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** UTC bucket start for a timestamp, as an ISO string. */
function bucketStartIso(timestamp: Date, bucket: ActivityBucketSize): string {
  const start = new Date(timestamp);
  start.setUTCMinutes(0, 0, 0);
  if (bucket === "day") {
    start.setUTCHours(0);
  }
  return start.toISOString();
}

export class PostgresRepository
  implements
    PreferenceRepositoryPort,
    LeaderboardPort,
    MatchmakingStatsPort,
    AnalyticsPort
{
  constructor(private readonly pool: Pool) {}

  async listEnabledModels(): Promise<Model[]> {
    const result = await this.pool.query<ModelRow>(
      `SELECT id, display_name, provider, provider_model_id, enabled
       FROM models
       WHERE enabled = TRUE
       ORDER BY created_at, id`,
    );
    return result.rows.map(mapModel);
  }

  async createMatchup(matchup: MatchupRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (matchup.conversation.turnIndex === 0) {
        await client.query(
          `INSERT INTO conversations (id, anonymous_session_id)
           VALUES ($1, $2)`,
          [
            matchup.conversation.id,
            matchup.conversation.anonymousSessionId,
          ],
        );
      } else {
        const latest = await client.query<{
          turn_index: number;
          winner_response_id: string | null;
        }>(
          `SELECT
             t.turn_index,
             winner.id AS winner_response_id
           FROM turns t
           LEFT JOIN preferences p ON p.matchup_id = t.matchup_id
           LEFT JOIN responses winner
             ON winner.matchup_id = t.matchup_id
             AND winner.model_id = p.winner_model_id
           WHERE t.conversation_id = $1
           ORDER BY t.turn_index DESC
           LIMIT 1`,
          [matchup.conversation.id],
        );
        const previous = latest.rows[0];
        if (
          !previous ||
          previous.turn_index !== matchup.conversation.turnIndex - 1 ||
          previous.winner_response_id !==
            matchup.conversation.parentResponseId
        ) {
          throw new ConversationConflictError();
        }
      }

      await client.query(
        `INSERT INTO matchups (
          id, prompt, model_a_id, model_b_id, slot_a_model_id,
          slot_b_model_id, matchup_token_hash, harness_version, mode
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          matchup.id,
          matchup.prompt,
          matchup.modelAId,
          matchup.modelBId,
          matchup.slotAModelId,
          matchup.slotBModelId,
          matchup.matchupTokenHash,
          matchup.harnessVersion,
          matchup.mode,
        ],
      );
      await client.query(
        `INSERT INTO turns (
          id, conversation_id, matchup_id, parent_response_id,
          turn_index, prompt
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          matchup.conversation.turnId,
          matchup.conversation.id,
          matchup.id,
          matchup.conversation.parentResponseId,
          matchup.conversation.turnIndex,
          matchup.prompt,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new ConversationConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async saveResponse(response: ResponseRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO responses (
        id, matchup_id, slot, model_id, content, latency_ms,
        ttft_ms, stream_duration_ms, output_token_count,
        token_count_source, markdown_density, model_version, error
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      )
      ON CONFLICT (matchup_id, slot) DO NOTHING`,
      [
        randomUUID(),
        response.matchupId,
        response.slot,
        response.modelId,
        response.content,
        response.latencyMs,
        response.ttftMs,
        response.streamDurationMs,
        response.outputTokenCount,
        response.tokenCountSource,
        response.markdownDensity,
        response.modelVersion,
        response.error,
      ],
    );
  }

  async recordPreference(preference: PreferenceRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO preferences (
          id, matchup_id, vote, winner_model_id,
          position_bias_meta, anonymous_session_id
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          preference.matchupId,
          preference.vote,
          preference.winnerModelId,
          JSON.stringify(preference.positionBiasMeta),
          preference.anonymousSessionId,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DuplicateVoteError();
      }
      throw error;
    }
  }

  async getConversationContext(
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
  > {
    const result = await this.pool.query<{
      anonymous_session_id: string | null;
      turn_index: number;
      prompt: string;
      winner_response_id: string | null;
      winner_content: string | null;
    }>(
      `SELECT
        c.anonymous_session_id,
        t.turn_index,
        t.prompt,
        winner.id AS winner_response_id,
        winner.content AS winner_content
      FROM conversations c
      JOIN turns t ON t.conversation_id = c.id
      LEFT JOIN preferences p ON p.matchup_id = t.matchup_id
      LEFT JOIN responses winner
        ON winner.matchup_id = t.matchup_id
        AND winner.model_id = p.winner_model_id
      WHERE c.id = $1
      ORDER BY t.turn_index`,
      [conversationId],
    );
    if (result.rows.length === 0) {
      return { status: "not_found" };
    }
    if (result.rows[0]?.anonymous_session_id !== anonymousSessionId) {
      return { status: "forbidden" };
    }

    const latest = result.rows.at(-1);
    if (!latest?.winner_response_id || latest.winner_content === null) {
      return { status: "not_ready" };
    }

    const messages: ChatMessage[] = [];
    for (const row of result.rows) {
      if (!row.winner_response_id || row.winner_content === null) {
        return { status: "not_ready" };
      }
      messages.push(
        { role: "user", content: row.prompt },
        { role: "assistant", content: row.winner_content },
      );
    }

    return {
      status: "ready",
      conversationId,
      nextTurnIndex: latest.turn_index + 1,
      parentResponseId: latest.winner_response_id,
      messages,
    };
  }

  async getMatchup(matchupId: string): Promise<MatchupView | null> {
    const result = await this.pool.query<
      ModelRow & {
        matchup_id: string;
        matchup_token_hash: string;
        conversation_id: string;
        turn_index: number;
        vote: ArenaVote | null;
        mode: "blind" | "shadow";
        b_id: string;
        b_display_name: string;
        b_provider: string;
        b_provider_model_id: string;
        b_enabled: boolean;
      }
    >(
      `SELECT
        mt.id AS matchup_id,
        mt.matchup_token_hash,
        mt.mode,
        t.conversation_id,
        t.turn_index,
        p.vote,
        a.id,
        a.display_name,
        a.provider,
        a.provider_model_id,
        a.enabled,
        b.id AS b_id,
        b.display_name AS b_display_name,
        b.provider AS b_provider,
        b.provider_model_id AS b_provider_model_id,
        b.enabled AS b_enabled
      FROM matchups mt
      JOIN turns t ON t.matchup_id = mt.id
      JOIN models a ON a.id = mt.slot_a_model_id
      JOIN models b ON b.id = mt.slot_b_model_id
      LEFT JOIN preferences p ON p.matchup_id = mt.id
      WHERE mt.id = $1`,
      [matchupId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.matchup_id,
      matchupTokenHash: row.matchup_token_hash,
      conversationId: row.conversation_id,
      turnIndex: Number(row.turn_index),
      vote: row.vote,
      mode: row.mode,
      slotA: mapModel(row),
      slotB: mapModel({
        id: row.b_id,
        display_name: row.b_display_name,
        provider: row.b_provider,
        provider_model_id: row.b_provider_model_id,
        enabled: row.b_enabled,
      }),
    };
  }

  /**
   * The whole thread behind one conversation, unvoted last turn included —
   * that pending pair is exactly the state a reload has to restore. Both slots
   * come back on every turn; disclosing which model wrote which is the
   * caller's decision and is gated on `vote` in `routes/reveal.ts`.
   */
  async getConversationTurns(
    conversationId: string,
    anonymousSessionId: string | null,
  ): Promise<
    | { status: "ready"; conversationId: string; turns: ConversationTurn[] }
    | { status: "not_found" }
    | { status: "forbidden" }
  > {
    // One row per (turn, response): at most two per turn, so the fan-out is
    // bounded and the turns are reassembled below rather than in SQL.
    const result = await this.pool.query<
      ModelRow & {
        anonymous_session_id: string | null;
        turn_index: number;
        matchup_id: string;
        prompt: string;
        vote: ArenaVote | null;
        slot: ArenaSlot | null;
        content: string | null;
        error: string | null;
        b_id: string;
        b_display_name: string;
        b_provider: string;
        b_provider_model_id: string;
        b_enabled: boolean;
      }
    >(
      `SELECT
        c.anonymous_session_id,
        t.turn_index,
        t.matchup_id,
        t.prompt,
        p.vote,
        r.slot,
        r.content,
        r.error,
        a.id,
        a.display_name,
        a.provider,
        a.provider_model_id,
        a.enabled,
        b.id AS b_id,
        b.display_name AS b_display_name,
        b.provider AS b_provider,
        b.provider_model_id AS b_provider_model_id,
        b.enabled AS b_enabled
      FROM conversations c
      JOIN turns t ON t.conversation_id = c.id
      JOIN matchups mt ON mt.id = t.matchup_id
      JOIN models a ON a.id = mt.slot_a_model_id
      JOIN models b ON b.id = mt.slot_b_model_id
      LEFT JOIN preferences p ON p.matchup_id = t.matchup_id
      LEFT JOIN responses r ON r.matchup_id = t.matchup_id
      WHERE c.id = $1
      ORDER BY t.turn_index, r.slot`,
      [conversationId],
    );
    if (result.rows.length === 0) {
      return { status: "not_found" };
    }
    if (result.rows[0]?.anonymous_session_id !== anonymousSessionId) {
      return { status: "forbidden" };
    }

    const turns = new Map<number, ConversationTurn>();
    for (const row of result.rows) {
      const turnIndex = Number(row.turn_index);
      let turn = turns.get(turnIndex);
      if (!turn) {
        turn = {
          turnIndex,
          matchupId: row.matchup_id,
          prompt: row.prompt,
          answers: [],
          vote: row.vote,
          slotA: mapModel(row),
          slotB: mapModel({
            id: row.b_id,
            display_name: row.b_display_name,
            provider: row.b_provider,
            provider_model_id: row.b_provider_model_id,
            enabled: row.b_enabled,
          }),
        };
        turns.set(turnIndex, turn);
      }
      if (row.slot && row.content !== null) {
        turn.answers.push({
          slot: row.slot,
          content: row.content,
          error: row.error,
        });
      }
    }

    return {
      status: "ready",
      conversationId,
      turns: [...turns.values()].sort(
        (left, right) => left.turnIndex - right.turnIndex,
      ),
    };
  }

  async getMatchmakingStats(): Promise<MatchmakingStats> {
    const models = await this.listEnabledModels();

    // Games already played per canonical (unordered) pair; skips do not count
    // as evaluations. Under-sampled pairs surface as low or absent counts.
    const pairRows = await this.pool.query<{
      model_a: string;
      model_b: string;
      games: string;
    }>(
      `SELECT
        LEAST(mt.model_a_id, mt.model_b_id)    AS model_a,
        GREATEST(mt.model_a_id, mt.model_b_id) AS model_b,
        COUNT(*) AS games
      FROM preferences p
      JOIN matchups mt ON mt.id = p.matchup_id
      WHERE p.vote <> 'skip'
      GROUP BY model_a, model_b`,
    );

    // Rating-interval width is the model's current uncertainty; null-rated
    // models are simply absent so the matchmaker treats them as maximally
    // uncertain and explores them first.
    const uncertaintyRows = await this.pool.query<{
      model_id: string;
      width: number;
    }>(
      `SELECT model_id, (ci_upper - ci_lower) AS width FROM model_ratings`,
    );

    const ratingUncertainty: Record<string, number> = {};
    for (const row of uncertaintyRows.rows) {
      ratingUncertainty[row.model_id] = Number(row.width);
    }

    return {
      models,
      pairGames: pairRows.rows.map((row) => ({
        modelAId: row.model_a,
        modelBId: row.model_b,
        games: Number(row.games),
      })),
      ratingUncertainty,
    };
  }

  async getLeaderboard(): Promise<LeaderboardEntry[]> {
    // Rating fields come from model_ratings via LEFT JOIN, so they are null
    // until the Python worker has run. The style-controlled fields come from
    // the sibling model_style_ratings table (heavier periodic pass) and stay
    // null until that pass runs. The win-rate aggregation is unchanged.
    const result = await this.pool.query<{
      id: string;
      display_name: string;
      wins: string;
      losses: string;
      ties: string;
      skips: string;
      total_votes: string;
      rating: number | null;
      rating_stderr: number | null;
      ci_lower: number | null;
      ci_upper: number | null;
      component_id: number | null;
      style_rating: number | null;
      style_stderr: number | null;
      style_ci_lower: number | null;
      style_ci_upper: number | null;
    }>(
      `SELECT
        m.id,
        m.display_name,
        SUM(CASE
          WHEN p.winner_model_id = m.id THEN 1 ELSE 0
        END) AS wins,
        SUM(CASE
          WHEN p.vote IN ('left', 'right')
            AND p.winner_model_id <> m.id
          THEN 1 ELSE 0
        END) AS losses,
        SUM(CASE
          WHEN p.vote IN ('both_good', 'both_bad') THEN 1 ELSE 0
        END) AS ties,
        SUM(CASE WHEN p.vote = 'skip' THEN 1 ELSE 0 END) AS skips,
        COUNT(p.id) AS total_votes,
        mr.rating,
        mr.rating_stderr,
        mr.ci_lower,
        mr.ci_upper,
        mr.component_id,
        msr.style_controlled_rating AS style_rating,
        msr.style_controlled_stderr AS style_stderr,
        msr.style_ci_lower,
        msr.style_ci_upper
      FROM models m
      LEFT JOIN matchups mt
        ON m.id = mt.slot_a_model_id OR m.id = mt.slot_b_model_id
      LEFT JOIN preferences p ON p.matchup_id = mt.id
      LEFT JOIN model_ratings mr ON mr.model_id = m.id
      LEFT JOIN model_style_ratings msr ON msr.model_id = m.id
      WHERE m.enabled = TRUE
      GROUP BY m.id, m.display_name, mr.rating, mr.rating_stderr,
        mr.ci_lower, mr.ci_upper, mr.component_id,
        msr.style_controlled_rating, msr.style_controlled_stderr,
        msr.style_ci_lower, msr.style_ci_upper
      ORDER BY
        mr.rating DESC NULLS LAST,
        wins DESC, total_votes DESC, m.display_name`,
    );

    return result.rows.map((row) => {
      const wins = Number(row.wins);
      const losses = Number(row.losses);
      const ties = Number(row.ties);
      const denominator = wins + losses + ties;
      const rating = row.rating === null ? null : Number(row.rating);
      const ciLower = row.ci_lower === null ? null : Number(row.ci_lower);
      const ciUpper = row.ci_upper === null ? null : Number(row.ci_upper);
      const styleRating =
        row.style_rating === null ? null : Number(row.style_rating);
      const styleLower =
        row.style_ci_lower === null ? null : Number(row.style_ci_lower);
      const styleUpper =
        row.style_ci_upper === null ? null : Number(row.style_ci_upper);
      return {
        id: row.id,
        displayName: row.display_name,
        wins,
        losses,
        ties,
        skips: Number(row.skips),
        totalVotes: Number(row.total_votes),
        winRate: denominator === 0 ? 0 : wins / denominator,
        rating,
        ratingStdError:
          row.rating_stderr === null ? null : Number(row.rating_stderr),
        confidenceInterval:
          ciLower === null || ciUpper === null
            ? null
            : { lower: ciLower, upper: ciUpper },
        componentId:
          row.component_id === null ? null : Number(row.component_id),
        styleControlledRating: styleRating,
        styleControlledStdError:
          row.style_stderr === null ? null : Number(row.style_stderr),
        styleControlledConfidenceInterval:
          styleLower === null || styleUpper === null
            ? null
            : { lower: styleLower, upper: styleUpper },
      };
    });
  }

  /**
   * The qualifiers a reader needs before trusting the numbers in
   * `getLeaderboard`: whether the ratings are mutually comparable at all
   * (vision §4) and how much of a gap superficial style buys (vision §3). Both
   * come back empty on a fresh install where the worker has not run yet.
   */
  async getRatingContext(): Promise<RatingContext> {
    return {
      components: await this.readComponents(),
      styleControl: await this.readStyleControl(),
    };
  }

  private async readComponents(): Promise<LeaderboardComponents> {
    // Grouped in SQL: the response only ever needs per-component head-counts,
    // and each model's own component id already rides on the leaderboard row.
    const result = await this.pool.query<{
      component_id: number;
      models: string;
    }>(
      `SELECT mr.component_id, COUNT(*) AS models
      FROM model_ratings mr
      JOIN models m ON m.id = mr.model_id
      WHERE m.enabled = TRUE
      GROUP BY mr.component_id
      ORDER BY mr.component_id`,
    );
    return {
      count: result.rows.length === 0 ? null : result.rows.length,
      groups: result.rows.map((row) => ({
        componentId: Number(row.component_id),
        models: Number(row.models),
      })),
    };
  }

  private async readStyleControl(): Promise<StyleControlReport> {
    const result = await this.pool.query<{
      feature: string;
      coefficient: number;
      computed_at: Date;
    }>(
      `SELECT feature, coefficient, computed_at
      FROM style_control_coefficients`,
    );
    if (result.rows.length === 0) {
      return { effects: [], votesObserved: 0, computedAt: null };
    }

    const spread = await this.readStyleFeatureSpread();
    const effects: StyleEffect[] = result.rows.map((row) => {
      const logOdds = Number(row.coefficient);
      const points = logOdds * DISPLAY_SCALE;
      const absolute = ABSOLUTE_STYLE_FEATURES.has(row.feature);
      const denominator = STYLE_FEATURE_UNITS[row.feature];
      const stdDev = spread.stdDev[row.feature] ?? null;
      return {
        feature: row.feature,
        logOdds,
        points,
        basis: absolute ? "absolute" : "per_std_dev",
        perUnit:
          absolute || !denominator || stdDev === null
            ? null
            : {
                points: (points / stdDev) * denominator.size,
                unit: denominator.unit,
              },
      };
    });
    effects.sort((left, right) => {
      const leftRank = STYLE_FEATURE_ORDER.indexOf(left.feature);
      const rightRank = STYLE_FEATURE_ORDER.indexOf(right.feature);
      // Features the worker adds later are unknown here; keep them last but
      // still expose them rather than dropping the row on the floor.
      return (
        (leftRank === -1 ? STYLE_FEATURE_ORDER.length : leftRank) -
        (rightRank === -1 ? STYLE_FEATURE_ORDER.length : rightRank)
      );
    });

    const computedAt = result.rows
      .map((row) => new Date(row.computed_at).toISOString())
      .sort()
      .at(-1);
    return {
      effects,
      votesObserved: spread.votes,
      computedAt: computedAt ?? null,
    };
  }

  /**
   * Standard deviation of each per-vote style delta, from sums computed in
   * Postgres so the raw vote rows never leave the database.
   *
   * This exists because the worker throws the scale away: `style.py` z-scales
   * its continuous covariates for conditioning and keeps `feature_scale` only
   * in process, so the persisted coefficients are per standard deviation and
   * nothing in the database says how big a standard deviation is. Recovering it
   * here is what turns a coefficient into "points per 100 tokens". The sample is
   * today's non-skip votes over the enabled roster, a superset of the worker's
   * when its anomaly screen excluded sessions or a model was later disabled, so
   * the per-unit restatement is indicative where the log-odds value is exact.
   */
  private async readStyleFeatureSpread(): Promise<{
    votes: number;
    stdDev: Record<string, number | null>;
  }> {
    const result = await this.pool.query<{
      votes: string;
      verbosity_sum: string | null;
      verbosity_square_sum: string | null;
      formatting_sum: string | null;
      formatting_square_sum: string | null;
      ttft_sum: string | null;
      ttft_square_sum: string | null;
      duration_sum: string | null;
      duration_square_sum: string | null;
    }>(
      // COALESCE mirrors the worker's null-to-zero coercion for ttft_ms.
      `SELECT
        COUNT(*) AS votes,
        SUM(ra.output_token_count - rb.output_token_count)
          AS verbosity_sum,
        SUM((ra.output_token_count - rb.output_token_count)
          * (ra.output_token_count - rb.output_token_count))
          AS verbosity_square_sum,
        SUM(ra.markdown_density - rb.markdown_density)
          AS formatting_sum,
        SUM((ra.markdown_density - rb.markdown_density)
          * (ra.markdown_density - rb.markdown_density))
          AS formatting_square_sum,
        SUM(COALESCE(ra.ttft_ms, 0) - COALESCE(rb.ttft_ms, 0))
          AS ttft_sum,
        SUM((COALESCE(ra.ttft_ms, 0) - COALESCE(rb.ttft_ms, 0))
          * (COALESCE(ra.ttft_ms, 0) - COALESCE(rb.ttft_ms, 0)))
          AS ttft_square_sum,
        SUM(ra.stream_duration_ms - rb.stream_duration_ms)
          AS duration_sum,
        SUM((ra.stream_duration_ms - rb.stream_duration_ms)
          * (ra.stream_duration_ms - rb.stream_duration_ms))
          AS duration_square_sum
      FROM preferences p
      JOIN matchups mt ON mt.id = p.matchup_id
      JOIN responses ra ON ra.matchup_id = mt.id AND ra.slot = 'A'
      JOIN responses rb ON rb.matchup_id = mt.id AND rb.slot = 'B'
      JOIN models ma ON ma.id = mt.slot_a_model_id AND ma.enabled = TRUE
      JOIN models mb ON mb.id = mt.slot_b_model_id AND mb.enabled = TRUE
      WHERE p.vote <> 'skip'`,
    );

    const row = result.rows[0];
    const votes = Number(row?.votes ?? 0);
    const spreadOf = (
      sum: string | null | undefined,
      squareSum: string | null | undefined,
    ): number | null =>
      stdDevFromSums(Number(sum ?? 0), Number(squareSum ?? 0), votes);

    return {
      votes,
      stdDev: {
        verbosity: spreadOf(row?.verbosity_sum, row?.verbosity_square_sum),
        formatting: spreadOf(row?.formatting_sum, row?.formatting_square_sum),
        latency_ttft: spreadOf(row?.ttft_sum, row?.ttft_square_sum),
        latency_duration: spreadOf(row?.duration_sum, row?.duration_square_sum),
      },
    };
  }

  async getSummary(): Promise<ArenaSummary> {
    const matchupCount = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM matchups",
    );
    const voteAggregate = await this.pool.query<{
      total_votes: string;
      decisive: string | null;
      tie_votes: string | null;
      skip_votes: string | null;
      slot_a_wins: string | null;
      slot_b_wins: string | null;
    }>(
      `SELECT
        COUNT(*) AS total_votes,
        SUM(CASE WHEN p.vote IN ('left', 'right') THEN 1 ELSE 0 END)
          AS decisive,
        SUM(CASE
          WHEN p.vote IN ('both_good', 'both_bad') THEN 1 ELSE 0
        END) AS tie_votes,
        SUM(CASE WHEN p.vote = 'skip' THEN 1 ELSE 0 END) AS skip_votes,
        SUM(CASE
          WHEN p.winner_model_id = mt.slot_a_model_id THEN 1 ELSE 0
        END) AS slot_a_wins,
        SUM(CASE
          WHEN p.winner_model_id = mt.slot_b_model_id THEN 1 ELSE 0
        END) AS slot_b_wins
      FROM preferences p
      JOIN matchups mt ON mt.id = p.matchup_id`,
    );
    const enabledCount = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM models WHERE enabled = TRUE",
    );
    // Canonical pairs are deduplicated in TS: pg-mem (used by the
    // integration tests) has no LEAST/GREATEST over uuid.
    const pairRows = await this.pool.query<{
      model_a_id: string;
      model_b_id: string;
    }>(
      `SELECT mt.model_a_id, mt.model_b_id
      FROM preferences p
      JOIN matchups mt ON mt.id = p.matchup_id
      WHERE p.vote <> 'skip'`,
    );
    const sampledPairs = new Set(
      pairRows.rows.map((row) =>
        row.model_a_id < row.model_b_id
          ? `${row.model_a_id}|${row.model_b_id}`
          : `${row.model_b_id}|${row.model_a_id}`,
      ),
    );
    const componentRows = await this.pool.query<{ component_id: number }>(
      "SELECT DISTINCT component_id FROM model_ratings",
    );

    const votes = voteAggregate.rows[0];
    const enabledModels = Number(enabledCount.rows[0]?.n ?? 0);
    return {
      totalMatchups: Number(matchupCount.rows[0]?.n ?? 0),
      totalVotes: Number(votes?.total_votes ?? 0),
      decisiveVotes: Number(votes?.decisive ?? 0),
      tieVotes: Number(votes?.tie_votes ?? 0),
      skipVotes: Number(votes?.skip_votes ?? 0),
      slotAWins: Number(votes?.slot_a_wins ?? 0),
      slotBWins: Number(votes?.slot_b_wins ?? 0),
      enabledModels,
      pairsSampled: sampledPairs.size,
      pairsPossible: (enabledModels * (enabledModels - 1)) / 2,
      ratingComponents:
        componentRows.rows.length === 0 ? null : componentRows.rows.length,
    };
  }

  async getHeadToHead(): Promise<HeadToHeadStats> {
    const models = await this.listEnabledModels();
    // One row per non-skip vote; aggregated in TS to keep the SQL pg-mem
    // compatible (CASE over LEAST/GREATEST inside aggregates is not).
    const voteRows = await this.pool.query<{
      model_a_id: string;
      model_b_id: string;
      vote: string;
      winner_model_id: string | null;
    }>(
      `SELECT mt.model_a_id, mt.model_b_id, p.vote, p.winner_model_id
      FROM preferences p
      JOIN matchups mt ON mt.id = p.matchup_id
      WHERE p.vote <> 'skip'`,
    );

    const pairs = new Map<string, HeadToHeadPair>();
    for (const row of voteRows.rows) {
      const [low, high] =
        row.model_a_id < row.model_b_id
          ? [row.model_a_id, row.model_b_id]
          : [row.model_b_id, row.model_a_id];
      const key = `${low}|${high}`;
      let pair = pairs.get(key);
      if (!pair) {
        pair = {
          modelAId: low,
          modelBId: high,
          aWins: 0,
          bWins: 0,
          ties: 0,
          games: 0,
        };
        pairs.set(key, pair);
      }
      if (row.winner_model_id === low) {
        pair.aWins += 1;
      } else if (row.winner_model_id === high) {
        pair.bWins += 1;
      } else {
        pair.ties += 1;
      }
      pair.games += 1;
    }

    return {
      models: models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
      })),
      pairs: [...pairs.values()],
    };
  }

  async getModelMetrics(): Promise<ModelMetricsEntry[]> {
    const models = await this.listEnabledModels();
    const responseRows = await this.pool.query<{
      model_id: string;
      ttft_ms: number | null;
      stream_duration_ms: number;
      output_token_count: number;
      markdown_density: number;
    }>(
      `SELECT
        model_id, ttft_ms, stream_duration_ms,
        output_token_count, markdown_density
      FROM responses
      WHERE error IS NULL`,
    );
    const positionRows = await this.pool.query<{
      slot_a_model_id: string;
      slot_b_model_id: string;
      winner_model_id: string | null;
    }>(
      `SELECT mt.slot_a_model_id, mt.slot_b_model_id, p.winner_model_id
      FROM preferences p
      JOIN matchups mt ON mt.id = p.matchup_id
      WHERE p.vote IN ('left', 'right')`,
    );

    const byModel = new Map<string, (typeof responseRows.rows)[number][]>();
    for (const row of responseRows.rows) {
      const bucket = byModel.get(row.model_id);
      if (bucket) {
        bucket.push(row);
      } else {
        byModel.set(row.model_id, [row]);
      }
    }

    const position = new Map<
      string,
      { slotAWins: number; slotAGames: number; slotBWins: number; slotBGames: number }
    >();
    const positionFor = (modelId: string) => {
      let entry = position.get(modelId);
      if (!entry) {
        entry = { slotAWins: 0, slotAGames: 0, slotBWins: 0, slotBGames: 0 };
        position.set(modelId, entry);
      }
      return entry;
    };
    for (const row of positionRows.rows) {
      const slotA = positionFor(row.slot_a_model_id);
      slotA.slotAGames += 1;
      if (row.winner_model_id === row.slot_a_model_id) {
        slotA.slotAWins += 1;
      }
      const slotB = positionFor(row.slot_b_model_id);
      slotB.slotBGames += 1;
      if (row.winner_model_id === row.slot_b_model_id) {
        slotB.slotBWins += 1;
      }
    }

    return models.map((model) => {
      const responses = byModel.get(model.id) ?? [];
      const ttfts = responses
        .map((row) => row.ttft_ms)
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b);
      const durations = responses
        .map((row) => Number(row.stream_duration_ms))
        .sort((a, b) => a - b);
      const stats = position.get(model.id);
      return {
        id: model.id,
        displayName: model.displayName,
        responses: responses.length,
        ttftMsP50: percentile(ttfts, 0.5),
        ttftMsP90: percentile(ttfts, 0.9),
        durationMsP50: percentile(durations, 0.5),
        durationMsP90: percentile(durations, 0.9),
        meanOutputTokens: mean(
          responses.map((row) => Number(row.output_token_count)),
        ),
        meanMarkdownDensity: mean(
          responses.map((row) => Number(row.markdown_density)),
        ),
        slotAWins: stats?.slotAWins ?? 0,
        slotAGames: stats?.slotAGames ?? 0,
        slotBWins: stats?.slotBWins ?? 0,
        slotBGames: stats?.slotBGames ?? 0,
      };
    });
  }

  async getActivity(bucket: ActivityBucketSize): Promise<ActivityStats> {
    const models = await this.listEnabledModels();
    const voteRows = await this.pool.query<{
      vote: string;
      created_at: Date;
      model_a_id: string;
      model_b_id: string;
    }>(
      `SELECT p.vote, p.created_at, mt.model_a_id, mt.model_b_id
      FROM preferences p
      JOIN matchups mt ON mt.id = p.matchup_id
      ORDER BY p.created_at`,
    );

    const voteBuckets = new Map<string, ActivityVoteBucket>();
    const gamesPerBucket = new Map<string, Map<string, number>>();
    for (const row of voteRows.rows) {
      const start = bucketStartIso(new Date(row.created_at), bucket);
      let votes = voteBuckets.get(start);
      if (!votes) {
        votes = {
          bucketStart: start,
          left: 0,
          right: 0,
          bothGood: 0,
          bothBad: 0,
          skip: 0,
          total: 0,
        };
        voteBuckets.set(start, votes);
      }
      if (row.vote === "left") {
        votes.left += 1;
      } else if (row.vote === "right") {
        votes.right += 1;
      } else if (row.vote === "both_good") {
        votes.bothGood += 1;
      } else if (row.vote === "both_bad") {
        votes.bothBad += 1;
      } else {
        votes.skip += 1;
      }
      votes.total += 1;

      if (row.vote !== "skip") {
        let games = gamesPerBucket.get(start);
        if (!games) {
          games = new Map();
          gamesPerBucket.set(start, games);
        }
        games.set(row.model_a_id, (games.get(row.model_a_id) ?? 0) + 1);
        games.set(row.model_b_id, (games.get(row.model_b_id) ?? 0) + 1);
      }
    }

    const orderedStarts = [...voteBuckets.keys()].sort();
    const running = new Map<string, number>();
    const cumulativeGames: ActivityCumulativeBucket[] = orderedStarts.map(
      (start) => {
        for (const [modelId, count] of gamesPerBucket.get(start) ?? []) {
          running.set(modelId, (running.get(modelId) ?? 0) + count);
        }
        return { bucketStart: start, games: Object.fromEntries(running) };
      },
    );

    return {
      bucket,
      models: models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
      })),
      votes: orderedStarts.map((start) => {
        const votes = voteBuckets.get(start);
        if (!votes) {
          throw new Error(`Missing vote bucket for ${start}`);
        }
        return votes;
      }),
      cumulativeGames,
    };
  }

  async getStyleControl(): Promise<StyleControlStats> {
    const coefficientRows = await this.pool.query<{
      feature: string;
      coefficient: number;
      computed_at: Date;
    }>(
      `SELECT feature, coefficient, computed_at
      FROM style_control_coefficients
      ORDER BY feature`,
    );
    const modelRows = await this.pool.query<{
      id: string;
      display_name: string;
      rating: number;
      style_controlled_rating: number;
    }>(
      `SELECT
        m.id, m.display_name, mr.rating, msr.style_controlled_rating
      FROM models m
      JOIN model_ratings mr ON mr.model_id = m.id
      JOIN model_style_ratings msr ON msr.model_id = m.id
      WHERE m.enabled = TRUE
      ORDER BY mr.rating DESC`,
    );

    return {
      coefficients: coefficientRows.rows.map((row) => ({
        feature: row.feature,
        coefficient: Number(row.coefficient),
        computedAt: new Date(row.computed_at).toISOString(),
      })),
      models: modelRows.rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        rating: Number(row.rating),
        styleControlledRating: Number(row.style_controlled_rating),
      })),
    };
  }

  async getRatingHistory(since: Date | null): Promise<RatingHistoryStats> {
    const models = await this.listEnabledModels();
    const params: Date[] = [];
    let where = "";
    if (since) {
      params.push(since);
      where = "WHERE computed_at >= $1";
    }
    const historyRows = await this.pool.query<{
      model_id: string;
      rating: number;
      ci_lower: number;
      ci_upper: number;
      games: number;
      computed_at: Date;
    }>(
      `SELECT model_id, rating, ci_lower, ci_upper, games, computed_at
      FROM model_rating_history
      ${where}
      ORDER BY computed_at, model_id`,
      params,
    );

    return {
      models: models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
      })),
      points: historyRows.rows.map((row) => ({
        modelId: row.model_id,
        rating: Number(row.rating),
        ciLower: Number(row.ci_lower),
        ciUpper: Number(row.ci_upper),
        games: Number(row.games),
        computedAt: new Date(row.computed_at).toISOString(),
      })),
    };
  }
}
