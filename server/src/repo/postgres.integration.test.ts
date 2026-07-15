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
import { NoopPiiScrubber } from "../privacy/noop.js";
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
      piiScrubber: new NoopPiiScrubber(),
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
      expect(leaderboard.json().models).toEqual([
        expect.objectContaining({
          displayName: "Alpha",
          wins: 1,
          losses: 0,
          winRate: 1,
        }),
        expect.objectContaining({
          displayName: "Beta",
          wins: 0,
          losses: 1,
          winRate: 0,
        }),
      ]);
    } finally {
      await app.close();
      await pool.end();
    }
  });
});
