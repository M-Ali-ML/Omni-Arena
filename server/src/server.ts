import "./env.js";
import { createApp } from "./app.js";
import { ArenaCore } from "./core/arena.js";
import { pool } from "./db/pool.js";
import { RandomMatchmaker } from "./matchmaking/random.js";
import { GoogleModelProvider } from "./providers/google.js";
import { ProviderRegistry } from "./providers/registry.js";
import { PostgresRepository } from "./repo/postgres.js";
import { MatchupTokenService } from "./token.js";

const repository = new PostgresRepository(pool);
const googleApiKey = process.env.GOOGLE_API_KEY;
if (!googleApiKey) {
  throw new Error("GOOGLE_API_KEY is required");
}
const providers = new ProviderRegistry().register(
  "google",
  new GoogleModelProvider(googleApiKey),
);

const secret =
  process.env.MATCHUP_TOKEN_SECRET ?? "development-only-change-me";
if (!process.env.MATCHUP_TOKEN_SECRET) {
  console.warn(
    "MATCHUP_TOKEN_SECRET is unset; using an insecure development default",
  );
}

const app = await createApp({
  core: new ArenaCore(providers),
  matchmaker: new RandomMatchmaker(repository),
  repository,
  tokens: new MatchupTokenService(secret),
  webOrigin: process.env.WEB_ORIGIN,
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
