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

      const second = await runMigrations(pool);
      expect(second).toEqual([]);

      const { rows } = await pool.query(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      expect(rows.map((row: { name: string }) => row.name)).toEqual(first);
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
          ('004_phase_three.sql')`,
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
      ]);
    } finally {
      await pool.end();
    }
  });
});
