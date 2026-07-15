import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { ArenaCore } from "./core/arena.js";
import type {
  LeaderboardPort,
  MatchmakingPort,
  PreferenceRepositoryPort,
} from "./core/ports.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerLeaderboardRoute } from "./routes/leaderboard.js";
import { registerVoteRoute } from "./routes/vote.js";
import type { MatchupTokenService } from "./token.js";

export interface AppDependencies {
  core: ArenaCore;
  matchmaker: MatchmakingPort;
  repository: PreferenceRepositoryPort & LeaderboardPort;
  tokens: MatchupTokenService;
  harnessVersion: string;
  webOrigin?: string;
  logger?: boolean;
}

export async function createApp(
  dependencies: AppDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: dependencies.logger ?? false });

  await app.register(cors, {
    origin: dependencies.webOrigin ?? "http://localhost:5173",
    methods: ["GET", "POST"],
  });

  app.get("/health", async () => ({ status: "ok" }));
  registerChatRoute(app, dependencies);
  registerVoteRoute(app, dependencies);
  registerLeaderboardRoute(app, dependencies.repository);

  return app;
}
