// A credential-free OmniArena server for this integration: the real Fastify app
// (routes, adapters, matchmaking, token service) over an in-memory Postgres
// (pg-mem) and the deterministic mock provider. No Docker, no API keys.
//
// Ports: arena 3031, app 3300 (3011/3100 = assistant-ui, 3021/3200 = vercel).
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { createApp } from "../../../server/src/app.js";
import { ArenaCore } from "../../../server/src/core/arena.js";
import { runMigrations } from "../../../server/src/db/migrations.js";
import { RandomMatchmaker } from "../../../server/src/matchmaking/random.js";
import { MockModelProvider } from "../../../server/src/providers/mock.js";
import { ProviderRegistry } from "../../../server/src/providers/registry.js";
import { PostgresRepository } from "../../../server/src/repo/postgres.js";
import { MatchupTokenService } from "../../../server/src/token.js";
import { ShowcaseModelProvider } from "./showcase-provider.js";

/** Stable ids so the single-model (non-votable) plan can name one of them. */
const MOCK_ALPHA = "00000000-0000-4000-8000-0000000a11ce";
const MOCK_BETA = "00000000-0000-4000-8000-0000000b0b2b";

const port = Number(process.env.ARENA_PORT ?? 3031);
// `manual` by default so the app's "Arena mode" toggle is meaningful.
const trigger = process.env.ARENA_TRIGGER === "always" ? "always" : "manual";

const database = newDb();
const pool = new (database.adapters.createPg().Pool)() as unknown as Pool;

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
// `npm run screenshots` swaps the canned bytes for identity-free answers that
// stream slowly enough to photograph mid-run; everything else is untouched.
const provider =
  process.env.ARENA_SHOWCASE === "1"
    ? new ShowcaseModelProvider()
    : new MockModelProvider();
const app = await createApp({
  core: new ArenaCore(new ProviderRegistry().register("mock", provider)),
  // Fixed RNG keeps slot A on Mock Model Alpha so the reveal is assertable.
  matchmaker: new RandomMatchmaker(repository, () => 0.1),
  repository,
  tokens: new MatchupTokenService("copilotkit-integration-matchup-secret"),
  harnessVersion: "integration-copilotkit",
  modeConfig: {
    trigger,
    defaultModel: trigger === "manual" ? MOCK_ALPHA : null,
  },
  webOrigin: process.env.ARENA_WEB_ORIGIN ?? "http://localhost:3300",
  logger: false,
});

await app.listen({ host: "127.0.0.1", port });
console.log(
  `OmniArena (mock provider, pg-mem, trigger=${trigger}) listening on http://127.0.0.1:${port}`,
);

const shutdown = (): void => {
  void app
    .close()
    .then(() => pool.end())
    .then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
