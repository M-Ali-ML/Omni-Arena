import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { ArenaCore } from "../core/arena.js";
import type { MatchupAssignment, Model } from "../core/ports.js";
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
    const schema = await readFile(
      new URL("../db/schema.sql", import.meta.url),
      "utf8",
    );
    await pool.query(schema);
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
    const provider = {
      async *stream(model: Model) {
        yield `${model.displayName} answer`;
      },
    };
    const app = await createApp({
      core: new ArenaCore(new ProviderRegistry().register("test", provider)),
      matchmaker: { async pick() { return assignment; } },
      repository,
      tokens: new MatchupTokenService("integration-secret-long-enough"),
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
        "SELECT slot, content FROM responses ORDER BY slot",
      );
      expect(responseRows.rows).toEqual([
        { slot: "A", content: "Alpha answer" },
        { slot: "B", content: "Beta answer" },
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
