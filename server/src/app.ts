import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { MatchupRegistry } from "./control/registry.js";
import type { ArenaCore } from "./core/arena.js";
import type {
  LeaderboardPort,
  MatchmakingPort,
  PreferenceRepositoryPort,
} from "./core/ports.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerControlRoute } from "./routes/control.js";
import { registerLeaderboardRoute } from "./routes/leaderboard.js";
import { registerVoteRoute } from "./routes/vote.js";
import type { MatchupTokenService } from "./token.js";

export interface AppDependencies {
  core: ArenaCore;
  matchmaker: MatchmakingPort;
  repository: PreferenceRepositoryPort & LeaderboardPort;
  tokens: MatchupTokenService;
  harnessVersion: string;
  /** Shared in-flight matchup tracker for the WS control plane; created if absent. */
  registry?: MatchupRegistry;
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
  await app.register(websocket);

  const registry = dependencies.registry ?? new MatchupRegistry();

  app.get("/health", async () => ({ status: "ok" }));
  registerChatRoute(app, { ...dependencies, registry });
  registerVoteRoute(app, dependencies);
  registerLeaderboardRoute(app, dependencies.repository);
  registerControlRoute(app, { registry });

  return app;
}
