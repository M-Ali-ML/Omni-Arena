import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./migrations.js";

function memPool(): Pool {
  const adapter = newDb().adapters.createPg();
  return new adapter.Pool() as unknown as Pool;
}

describe("runMigrations", () => {
  it("applies every migration once and is idempotent", async () => {
    const pool = memPool();
    try {
      const first = await runMigrations(pool);
      expect(first).toContain("001_initial.sql");
      expect(first).toContain("002_conversations_and_turns.sql");
      expect(first).toContain("003_model_ratings.sql");
      expect(first).toContain("004_style_ratings.sql");
      expect(first).toContain("005_rating_history.sql");
      expect(first).toContain("006_arena_mode.sql");

      const second = await runMigrations(pool);
      expect(second).toEqual([]);

      const { rows } = await pool.query(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      expect(rows.map((row: { name: string }) => row.name)).toEqual(first);

      // pg-mem has limited information_schema; verify the column via DML.
      await pool.query(
        `INSERT INTO models (id, display_name, provider, provider_model_id)
         VALUES
           ('11111111-1111-4111-8111-111111111111', 'A', 't', 'a'),
           ('22222222-2222-4222-8222-222222222222', 'B', 't', 'b')`,
      );
      await pool.query(
        `INSERT INTO matchups (
          id, prompt, model_a_id, model_b_id, slot_a_model_id, slot_b_model_id,
          matchup_token_hash
        ) VALUES (
          '33333333-3333-4333-8333-333333333333', 'p',
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'hash'
        )`,
      );
      const modeRow = await pool.query<{ mode: string }>(
        `SELECT mode FROM matchups WHERE id = '33333333-3333-4333-8333-333333333333'`,
      );
      expect(modeRow.rows[0]?.mode).toBe("blind");
      await pool.query(
        `UPDATE matchups SET mode = 'shadow'
         WHERE id = '33333333-3333-4333-8333-333333333333'`,
      );
      const shadowRow = await pool.query<{ mode: string }>(
        `SELECT mode FROM matchups WHERE id = '33333333-3333-4333-8333-333333333333'`,
      );
      expect(shadowRow.rows[0]?.mode).toBe("shadow");
    } finally {
      await pool.end();
    }
  });

  it("rewrites legacy phase-named migration rows to the current names", async () => {
    const pool = memPool();
    try {
      await pool.query(
        `CREATE TABLE schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
      );
      await pool.query(
        `INSERT INTO schema_migrations (name) VALUES
          ('001_initial.sql'),
          ('002_phase_one.sql'),
          ('003_phase_two.sql'),
          ('004_phase_three.sql'),
          ('005_rating_history.sql'),
          ('006_arena_mode.sql')`,
      );

      const ran = await runMigrations(pool);
      expect(ran).toEqual([]);

      const { rows } = await pool.query(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      expect(rows.map((row: { name: string }) => row.name)).toEqual([
        "001_initial.sql",
        "002_conversations_and_turns.sql",
        "003_model_ratings.sql",
        "004_style_ratings.sql",
        "005_rating_history.sql",
        "006_arena_mode.sql",
      ]);
    } finally {
      await pool.end();
    }
  });
});
