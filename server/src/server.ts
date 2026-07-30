import "./env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { JoinBroker, parseJoinConfig } from "./arena/join.js";
import {
  assertArenaModeConfig,
  parseArenaModeConfig,
  resolveArenaDefaultModel,
} from "./arena/mode.js";
import { ArenaCore } from "./core/arena.js";
import type { MatchmakingPort } from "./core/ports.js";
import { pool } from "./db/pool.js";
import { RandomMatchmaker } from "./matchmaking/random.js";
import { SmartMatchmaker } from "./matchmaking/smart.js";
import { createProviderRegistry } from "./providers/configure.js";
import { PostgresRepository } from "./repo/postgres.js";
import { MatchupTokenService } from "./token.js";

const repository = new PostgresRepository(pool);
const providers = createProviderRegistry(process.env);

// Smart matchmaking is the default (it prioritises under-evaluated and
// high-variance pairs); set MATCHMAKER=random to fall back to uniform sampling.
function createMatchmaker(
  mode: string | undefined,
  repo: PostgresRepository,
): MatchmakingPort {
  if (mode === "random") {
    return new RandomMatchmaker(repo);
  }
  return new SmartMatchmaker(repo);
}

const secret =
  process.env.MATCHUP_TOKEN_SECRET ?? "development-only-change-me";
if (!process.env.MATCHUP_TOKEN_SECRET) {
  console.warn(
    "MATCHUP_TOKEN_SECRET is unset; using an insecure development default",
  );
}

// Resolve the built web bundle relative to this file so the same layout works
// both in the repo (server/dist -> web/dist) and in the Docker image. Override
// with WEB_DIST_DIR when the bundle lives elsewhere.
const here = path.dirname(fileURLToPath(import.meta.url));
const webDistDir =
  process.env.WEB_DIST_DIR ?? path.resolve(here, "../../web/dist");

// Fail fast at boot when a non-`always` trigger has no model to serve `single`
// plans, and resolve human identifiers (slug / display_name /
// provider:provider_model_id) to a models.id UUID against the enabled roster.
const parsedModeConfig = parseArenaModeConfig(process.env);
assertArenaModeConfig(parsedModeConfig);
const modeConfig = resolveArenaDefaultModel(
  parsedModeConfig,
  await repository.listEnabledModels(),
);

const app = await createApp({
  core: new ArenaCore(providers),
  matchmaker: createMatchmaker(process.env.MATCHMAKER, repository),
  repository,
  analytics: repository,
  tokens: new MatchupTokenService(secret),
  harnessVersion: process.env.HARNESS_VERSION ?? "v1",
  modeConfig,
  joinBroker: new JoinBroker(parseJoinConfig(process.env)),
  webOrigin: process.env.WEB_ORIGIN,
  webDistDir,
  logger: true,
});

const port = Number(process.env.PORT ?? 3001);
await app.listen({ host: "0.0.0.0", port });

const shutdown = async (): Promise<void> => {
  await app.close();
  await pool.end();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
