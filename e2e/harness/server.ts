import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { createApp } from "../../server/src/app.js";
import { ArenaCore } from "../../server/src/core/arena.js";
import { runMigrations } from "../../server/src/db/migrations.js";
import { RandomMatchmaker } from "../../server/src/matchmaking/random.js";
import { MockModelProvider } from "../../server/src/providers/mock.js";
import { ProviderRegistry } from "../../server/src/providers/registry.js";
import { PostgresRepository } from "../../server/src/repo/postgres.js";
import { MatchupTokenService } from "../../server/src/token.js";

export interface HarnessHandle {
  port: number;
  origin: string;
  close: () => Promise<void>;
}

/** Stable ids so callers can name a specific mock model (e.g. as a default). */
export const MOCK_ALPHA = "00000000-0000-4000-8000-000000000a1a";
export const MOCK_BETA = "00000000-0000-4000-8000-000000000b2b";

/**
 * Boots the real OmniArena Fastify app over an in-memory Postgres (pg-mem) and
 * the deterministic mock provider, then listens on a real port. This is the
 * whole stack — routes, adapters, matchmaking, token service — with zero
 * external dependencies (no Docker, no API keys), so e2e runs are deterministic
 * and CI-friendly.
 */
export async function startHarness(
  options: {
    port?: number;
    webOrigin?: string;
    /** Arena trigger/exposure config; defaults to `always` like production. */
    modeConfig?: { trigger: "always" | "manual"; defaultModel: string | null };
  } = {},
): Promise<HarnessHandle> {
  const database = newDb();
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool() as unknown as Pool;

  await runMigrations(pool);
  await pool.query(
    `INSERT INTO models (
      id, display_name, provider, provider_model_id, enabled
    ) VALUES
      ($1, 'Mock Model Alpha', 'mock', 'mock-alpha', TRUE),
      ($2, 'Mock Model Beta', 'mock', 'mock-beta', TRUE)`,
    [MOCK_ALPHA, MOCK_BETA],
  );

  const repository = new PostgresRepository(pool);
  const providers = new ProviderRegistry().register(
    "mock",
    new MockModelProvider(),
  );

  const app = await createApp({
    core: new ArenaCore(providers),
    // Fixed RNG so slot A is always Mock Model Alpha — keeps assertions stable.
    matchmaker: new RandomMatchmaker(repository, () => 0.1),
    repository,
    tokens: new MatchupTokenService("e2e-matchup-secret-long-enough-value"),
    harnessVersion: "e2e",
    modeConfig: options.modeConfig,
    webOrigin: options.webOrigin,
    logger: false,
  });

  const port = options.port ?? 3101;
  await app.listen({ host: "127.0.0.1", port });

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}
