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
});
