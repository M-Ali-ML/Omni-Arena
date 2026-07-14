import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const migrationsDir = path.dirname(
  fileURLToPath(new URL("./migrations/001_initial.sql", import.meta.url)),
);

export async function runMigrations(pool: Pool): Promise<string[]> {
  // Existence check instead of IF NOT EXISTS: pg-mem (used in tests) fails
  // AST coverage when CREATE TABLE IF NOT EXISTS hits an existing table.
  const tableCheck = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_name = 'schema_migrations'`,
  );
  if (tableCheck.rows.length === 0) {
    await pool.query(
      `CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );
  }

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations",
  );
  const applied = new Set(rows.map((row) => row.name));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        file,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    ran.push(file);
  }
  return ran;
}
