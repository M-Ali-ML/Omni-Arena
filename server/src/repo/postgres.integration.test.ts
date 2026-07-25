import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { ArenaCore } from "../core/arena.js";
import type {
  ChatMessage,
  MatchupAssignment,
  Model,
} from "../core/ports.js";
import { runMigrations } from "../db/migrations.js";
import { ProviderRegistry } from "../providers/registry.js";
import { PostgresRepository } from "./postgres.js";
import { MatchupTokenService } from "../token.js";

function parseStarted(body: string): {
  matchupId: string;
  matchupToken: string;
} {
  const block = body.split(/\r?\n\r?\n/)[0] ?? "";
  const data = block
    .split(/\r?\n/)
    .find((line) => line.startsWith("data:"))
    ?.slice(5)
    .trim();
  if (!data) {
    throw new Error("Missing matchup_started event");
  }
  return JSON.parse(data) as {
    matchupId: string;
    matchupToken: string;
  };
}

describe("Postgres-backed arena flow", () => {
  it("persists responses and updates the leaderboard after a vote", async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as unknown as Pool;
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO models (
        id, display_name, provider, provider_model_id, enabled
      ) VALUES
        ('00000000-0000-4000-8000-000000000001', 'Alpha', 'test', 'alpha', TRUE),
        ('00000000-0000-4000-8000-000000000002', 'Beta', 'test', 'beta', TRUE)`,
    );

    const repository = new PostgresRepository(pool);
    const [slotA, slotB] = await repository.listEnabledModels();
    if (!slotA || !slotB) {
      throw new Error("Test models were not seeded");
    }
    const assignment: MatchupAssignment = {
      modelA: slotA,
      modelB: slotB,
      slotA,
      slotB,
    };
    const receivedMessages: ChatMessage[][] = [];
    const provider = {
      async *stream(model: Model, messages: ChatMessage[]) {
        receivedMessages.push(messages);
        yield {
          type: "metadata" as const,
          modelVersion: `${model.providerModelId}-revision`,
          outputTokenCount: 2,
        };
        yield {
          type: "token" as const,
          token: `${model.displayName} answer`,
        };
      },
    };
    const app = await createApp({
      core: new ArenaCore(new ProviderRegistry().register("test", provider)),
      matchmaker: { async pick() { return assignment; } },
      repository,
      tokens: new MatchupTokenService("integration-secret-long-enough"),
      harnessVersion: "integration-v1",
    });

    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: { prompt: "Compare these" },
      });
      expect(chat.statusCode).toBe(200);
      const started = parseStarted(chat.body);

      const responseRows = await pool.query(
        `SELECT
          slot, content, output_token_count, token_count_source, model_version
         FROM responses ORDER BY slot`,
      );
      expect(responseRows.rows).toEqual([
        {
          slot: "A",
          content: "Alpha answer",
          output_token_count: 2,
          token_count_source: "provider",
          model_version: "alpha-revision",
        },
        {
          slot: "B",
          content: "Beta answer",
          output_token_count: 2,
          token_count_source: "provider",
          model_version: "beta-revision",
        },
      ]);

      const vote = await app.inject({
        method: "POST",
        url: "/api/arena/vote",
        payload: {
          matchupId: started.matchupId,
          matchupToken: started.matchupToken,
          vote: "left",
        },
      });
      expect(vote.statusCode).toBe(200);

      const followUp = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: {
          prompt: "Go deeper",
          conversationId: (
            JSON.parse(
              chat.body
                .split(/\r?\n/u)
                .find((line) => line.startsWith("data:"))
                ?.slice(5)
                .trim() ?? "{}",
            ) as { conversationId?: string }
          ).conversationId,
        },
      });
      expect(followUp.statusCode).toBe(200);
      expect(receivedMessages.at(-1)).toEqual([
        { role: "user", content: "Compare these" },
        { role: "assistant", content: "Alpha answer" },
        { role: "user", content: "Go deeper" },
      ]);
      const turns = await pool.query(
        `SELECT t.turn_index, t.parent_response_id, mt.harness_version
         FROM turns t
         JOIN matchups mt ON mt.id = t.matchup_id
         ORDER BY t.turn_index`,
      );
      expect(turns.rows).toEqual([
        {
          turn_index: 0,
          parent_response_id: null,
          harness_version: "integration-v1",
        },
        {
          turn_index: 1,
          parent_response_id: expect.any(String),
          harness_version: "integration-v1",
        },
      ]);

      const leaderboard = await app.inject({
        method: "GET",
        url: "/api/arena/leaderboard",
      });
      expect(leaderboard.statusCode).toBe(200);
      // Fresh install: the worker has not run, so the rating context is empty
      // rather than absent.
      expect(leaderboard.json().components).toEqual({
        count: null,
        groups: [],
      });
      expect(leaderboard.json().styleControl).toEqual({
        effects: [],
        votesObserved: 0,
        computedAt: null,
      });
      expect(leaderboard.json().models).toEqual([
        expect.objectContaining({
          displayName: "Alpha",
          wins: 1,
          losses: 0,
          winRate: 1,
          // Rating fields are null until the worker has run.
          rating: null,
          ratingStdError: null,
          confidenceInterval: null,
          componentId: null,
        }),
        expect.objectContaining({
          displayName: "Beta",
          wins: 0,
          losses: 1,
          winRate: 0,
          rating: null,
        }),
      ]);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it("aggregates analytics from votes, responses, and worker tables", async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as unknown as Pool;
    await runMigrations(pool);

    const alpha = "00000000-0000-4000-8000-000000000001";
    const beta = "00000000-0000-4000-8000-000000000002";
    const gamma = "00000000-0000-4000-8000-000000000003";
    await pool.query(
      `INSERT INTO models (
        id, display_name, provider, provider_model_id, enabled
      ) VALUES
        ('${alpha}', 'Alpha', 'test', 'alpha', TRUE),
        ('${beta}', 'Beta', 'test', 'beta', TRUE),
        ('${gamma}', 'Gamma', 'test', 'gamma', TRUE)`,
    );

    // m1: Alpha in slot A beats Beta (left). m2: slots swapped, Alpha still
    // wins from slot B (right). m3: Alpha/Gamma tie. m4: Beta/Gamma skipped.
    const m1 = "00000000-0000-4000-8000-000000000011";
    const m2 = "00000000-0000-4000-8000-000000000012";
    const m3 = "00000000-0000-4000-8000-000000000013";
    const m4 = "00000000-0000-4000-8000-000000000014";
    await pool.query(
      `INSERT INTO matchups (
        id, prompt, model_a_id, model_b_id,
        slot_a_model_id, slot_b_model_id, matchup_token_hash
      ) VALUES
        ('${m1}', 'p1', '${alpha}', '${beta}', '${alpha}', '${beta}', 'h1'),
        ('${m2}', 'p2', '${alpha}', '${beta}', '${beta}', '${alpha}', 'h2'),
        ('${m3}', 'p3', '${alpha}', '${gamma}', '${alpha}', '${gamma}', 'h3'),
        ('${m4}', 'p4', '${beta}', '${gamma}', '${beta}', '${gamma}', 'h4')`,
    );
    await pool.query(
      `INSERT INTO preferences (id, matchup_id, vote, winner_model_id) VALUES
        ('00000000-0000-4000-8000-000000000021', '${m1}', 'left', '${alpha}'),
        ('00000000-0000-4000-8000-000000000022', '${m2}', 'right', '${alpha}'),
        ('00000000-0000-4000-8000-000000000023', '${m3}', 'both_good', NULL),
        ('00000000-0000-4000-8000-000000000024', '${m4}', 'skip', NULL)`,
    );
    // Three error-free Alpha responses for the percentile math, plus one
    // errored response that must be excluded from the metrics.
    await pool.query(
      `INSERT INTO responses (
        id, matchup_id, slot, model_id, content, latency_ms, ttft_ms,
        stream_duration_ms, output_token_count, token_count_source,
        markdown_density, error
      ) VALUES
        ('00000000-0000-4000-8000-000000000031', '${m1}', 'A', '${alpha}',
          'a1', 1000, 100, 1000, 100, 'provider', 0.1, NULL),
        ('00000000-0000-4000-8000-000000000032', '${m2}', 'B', '${alpha}',
          'a2', 2000, 200, 2000, 200, 'provider', 0.2, NULL),
        ('00000000-0000-4000-8000-000000000033', '${m3}', 'A', '${alpha}',
          'a3', 3000, 300, 3000, 300, 'provider', 0.3, NULL),
        ('00000000-0000-4000-8000-000000000034', '${m1}', 'B', '${beta}',
          'b1', 4000, 400, 4000, 400, 'provider', 0.4, 'boom')`,
    );
    await pool.query(
      `INSERT INTO model_ratings (
        model_id, rating, rating_stderr, ci_lower, ci_upper,
        component_id, games
      ) VALUES
        ('${alpha}', 1100, 40, 1020, 1180, 0, 3),
        ('${beta}', 950, 45, 860, 1040, 0, 2)`,
    );
    await pool.query(
      `INSERT INTO model_style_ratings (
        model_id, style_controlled_rating, style_controlled_stderr,
        style_ci_lower, style_ci_upper, component_id, games
      ) VALUES
        ('${alpha}', 1060, 42, 976, 1144, 0, 3),
        ('${beta}', 980, 47, 886, 1074, 0, 2)`,
    );
    await pool.query(
      `INSERT INTO style_control_coefficients (feature, coefficient) VALUES
        ('verbosity', 0.31),
        ('position', 0.05)`,
    );
    await pool.query(
      `INSERT INTO model_rating_history (
        model_id, rating, rating_stderr, ci_lower, ci_upper,
        component_id, games, computed_at
      ) VALUES
        ('${alpha}', 1050, 60, 930, 1170, 0, 1, '2026-07-01T00:00:00Z'),
        ('${alpha}', 1100, 40, 1020, 1180, 0, 3, '2026-07-02T00:00:00Z')`,
    );

    const repository = new PostgresRepository(pool);
    try {
      const summary = await repository.getSummary();
      expect(summary).toEqual({
        totalMatchups: 4,
        totalVotes: 4,
        decisiveVotes: 2,
        tieVotes: 1,
        skipVotes: 1,
        slotAWins: 1,
        slotBWins: 1,
        enabledModels: 3,
        pairsSampled: 2,
        pairsPossible: 3,
        ratingComponents: 1,
      });

      const headToHead = await repository.getHeadToHead();
      expect(headToHead.models).toHaveLength(3);
      expect(headToHead.pairs).toEqual(
        expect.arrayContaining([
          {
            modelAId: alpha,
            modelBId: beta,
            aWins: 2,
            bWins: 0,
            ties: 0,
            games: 2,
          },
          {
            modelAId: alpha,
            modelBId: gamma,
            aWins: 0,
            bWins: 0,
            ties: 1,
            games: 1,
          },
        ]),
      );
      expect(headToHead.pairs).toHaveLength(2);

      const metrics = await repository.getModelMetrics();
      const alphaMetrics = metrics.find((entry) => entry.id === alpha);
      expect(alphaMetrics).toMatchObject({
        responses: 3,
        ttftMsP50: 200,
        durationMsP50: 2000,
        meanOutputTokens: 200,
        slotAWins: 1,
        slotAGames: 1,
        slotBWins: 1,
        slotBGames: 1,
      });
      expect(alphaMetrics?.ttftMsP90).toBeCloseTo(280, 6);
      expect(alphaMetrics?.meanMarkdownDensity).toBeCloseTo(0.2, 6);
      const betaMetrics = metrics.find((entry) => entry.id === beta);
      // Beta's only response errored, so its style metrics stay null.
      expect(betaMetrics).toMatchObject({
        responses: 0,
        ttftMsP50: null,
        meanOutputTokens: null,
        slotAWins: 0,
        slotAGames: 1,
        slotBWins: 0,
        slotBGames: 1,
      });

      const activity = await repository.getActivity("day");
      expect(activity.votes).toHaveLength(1);
      expect(activity.votes[0]).toMatchObject({
        left: 1,
        right: 1,
        bothGood: 1,
        bothBad: 0,
        skip: 1,
        total: 4,
      });
      expect(activity.cumulativeGames.at(-1)?.games).toEqual({
        [alpha]: 3,
        [beta]: 2,
        [gamma]: 1,
      });

      const style = await repository.getStyleControl();
      expect(style.coefficients).toEqual([
        expect.objectContaining({ feature: "position", coefficient: 0.05 }),
        expect.objectContaining({ feature: "verbosity", coefficient: 0.31 }),
      ]);
      expect(style.models).toEqual([
        expect.objectContaining({
          id: alpha,
          rating: 1100,
          styleControlledRating: 1060,
        }),
        expect.objectContaining({
          id: beta,
          rating: 950,
          styleControlledRating: 980,
        }),
      ]);

      const history = await repository.getRatingHistory(null);
      expect(history.points).toHaveLength(2);
      expect(history.points[0]).toMatchObject({ modelId: alpha, rating: 1050 });

      const recent = await repository.getRatingHistory(
        new Date("2026-07-01T12:00:00Z"),
      );
      expect(recent.points).toHaveLength(1);
      expect(recent.points[0]).toMatchObject({ rating: 1100 });
    } finally {
      await pool.end();
    }
  });

  it("scales style coefficients and groups components for the leaderboard", async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as unknown as Pool;
    await runMigrations(pool);

    const alpha = "00000000-0000-4000-8000-000000000001";
    const beta = "00000000-0000-4000-8000-000000000002";
    const gamma = "00000000-0000-4000-8000-000000000003";
    const retired = "00000000-0000-4000-8000-000000000004";
    await pool.query(
      `INSERT INTO models (
        id, display_name, provider, provider_model_id, enabled
      ) VALUES
        ('${alpha}', 'Alpha', 'test', 'alpha', TRUE),
        ('${beta}', 'Beta', 'test', 'beta', TRUE),
        ('${gamma}', 'Gamma', 'test', 'gamma', TRUE),
        ('${retired}', 'Retired', 'test', 'retired', FALSE)`,
    );

    const m1 = "00000000-0000-4000-8000-000000000011";
    const m2 = "00000000-0000-4000-8000-000000000012";
    await pool.query(
      `INSERT INTO matchups (
        id, prompt, model_a_id, model_b_id,
        slot_a_model_id, slot_b_model_id, matchup_token_hash
      ) VALUES
        ('${m1}', 'p1', '${alpha}', '${beta}', '${alpha}', '${beta}', 'h1'),
        ('${m2}', 'p2', '${alpha}', '${beta}', '${alpha}', '${beta}', 'h2')`,
    );
    await pool.query(
      `INSERT INTO preferences (id, matchup_id, vote, winner_model_id) VALUES
        ('00000000-0000-4000-8000-000000000021', '${m1}', 'left', '${alpha}'),
        ('00000000-0000-4000-8000-000000000022', '${m2}', 'both_good', NULL)`,
    );
    // Slot-A-minus-slot-B deltas across the two votes: verbosity 100 and 0
    // (population SD 50), ttft 200 and 0 with a null coerced to zero (SD 100),
    // duration 0 and 1000 (SD 500), and markdown density identical in both
    // slots (no spread at all).
    await pool.query(
      `INSERT INTO responses (
        id, matchup_id, slot, model_id, content, latency_ms, ttft_ms,
        stream_duration_ms, output_token_count, token_count_source,
        markdown_density, error
      ) VALUES
        ('00000000-0000-4000-8000-000000000031', '${m1}', 'A', '${alpha}',
          'a1', 1000, 200, 1000, 100, 'provider', 0.2, NULL),
        ('00000000-0000-4000-8000-000000000032', '${m1}', 'B', '${beta}',
          'b1', 1000, NULL, 1000, 0, 'provider', 0.2, NULL),
        ('00000000-0000-4000-8000-000000000033', '${m2}', 'A', '${alpha}',
          'a2', 1000, 100, 2000, 0, 'provider', 0.5, NULL),
        ('00000000-0000-4000-8000-000000000034', '${m2}', 'B', '${beta}',
          'b2', 1000, 100, 1000, 0, 'provider', 0.5, NULL)`,
    );
    // Alpha and Beta share a component; Gamma is islanded; the disabled model
    // must not count towards the grouping at all.
    await pool.query(
      `INSERT INTO model_ratings (
        model_id, rating, rating_stderr, ci_lower, ci_upper,
        component_id, games
      ) VALUES
        ('${alpha}', 1100, 40, 1020, 1180, 0, 2),
        ('${beta}', 950, 45, 860, 1040, 0, 2),
        ('${gamma}', 1000, 90, 820, 1180, 1, 1),
        ('${retired}', 1000, 90, 820, 1180, 2, 1)`,
    );
    // Deliberately out of fit order to prove the response is re-ordered.
    await pool.query(
      `INSERT INTO style_control_coefficients (feature, coefficient) VALUES
        ('latency_duration', -0.02),
        ('verbosity', 0.1),
        ('position', 0.05),
        ('formatting', 0.4),
        ('latency_ttft', -0.05)`,
    );

    const repository = new PostgresRepository(pool);
    try {
      const context = await repository.getRatingContext();

      expect(context.components).toEqual({
        count: 2,
        groups: [
          { componentId: 0, models: 2 },
          { componentId: 1, models: 1 },
        ],
      });

      expect(context.styleControl.votesObserved).toBe(2);
      expect(context.styleControl.computedAt).toEqual(expect.any(String));
      expect(
        context.styleControl.effects.map((effect) => effect.feature),
      ).toEqual([
        "position",
        "verbosity",
        "formatting",
        "latency_ttft",
        "latency_duration",
      ]);

      // 400/ln 10 points per unit of log-odds, the worker's display scale.
      const [position, verbosity, formatting, ttft, duration] =
        context.styleControl.effects;
      expect(position).toMatchObject({ basis: "absolute", perUnit: null });
      expect(position?.points).toBeCloseTo(8.6859, 3);

      expect(verbosity?.basis).toBe("per_std_dev");
      expect(verbosity?.points).toBeCloseTo(17.3718, 3);
      expect(verbosity?.perUnit?.unit).toBe("100 output tokens");
      // 17.3718 points per 50-token SD, restated per 100 tokens.
      expect(verbosity?.perUnit?.points).toBeCloseTo(34.7436, 3);

      // Both slots always formatted identically, so no scale can be recovered.
      expect(formatting?.perUnit).toBeNull();
      expect(formatting?.points).toBeCloseTo(69.4872, 3);

      expect(ttft?.perUnit?.unit).toBe("100 ms of TTFT");
      expect(ttft?.perUnit?.points).toBeCloseTo(-8.6859, 3);

      expect(duration?.perUnit?.unit).toBe("second of streaming");
      expect(duration?.perUnit?.points).toBeCloseTo(-6.9487, 3);
    } finally {
      await pool.end();
    }
  });

  it("exposes worker-computed rating fields once model_ratings is populated", async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as unknown as Pool;
    await runMigrations(pool);
    await pool.query(
      `INSERT INTO models (
        id, display_name, provider, provider_model_id, enabled
      ) VALUES
        ('00000000-0000-4000-8000-000000000001', 'Alpha', 'test', 'alpha', TRUE),
        ('00000000-0000-4000-8000-000000000002', 'Beta', 'test', 'beta', TRUE)`,
    );
    // Only Alpha has a rating; Beta stays null (worker rated a subset).
    await pool.query(
      `INSERT INTO model_ratings (
        model_id, rating, rating_stderr, ci_lower, ci_upper,
        component_id, games
      ) VALUES
        ('00000000-0000-4000-8000-000000000001', 1180.5, 42.0, 1098.2, 1262.8, 0, 30)`,
    );

    const repository = new PostgresRepository(pool);
    try {
      const board = await repository.getLeaderboard();
      // Rated model sorts first (rating DESC NULLS LAST).
      expect(board[0]).toMatchObject({
        displayName: "Alpha",
        rating: 1180.5,
        ratingStdError: 42.0,
        confidenceInterval: { lower: 1098.2, upper: 1262.8 },
        componentId: 0,
      });
      expect(board[1]).toMatchObject({
        displayName: "Beta",
        rating: null,
        confidenceInterval: null,
        componentId: null,
      });
    } finally {
      await pool.end();
    }
  });
});
