import { existsSync } from "node:fs";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
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
  /**
   * Absolute path to the built web app (`web/dist`). When set and present, the
   * server also serves the SPA from the same origin so one container is the
   * whole app (single-tenant self-host). Omitted in dev, where Vite serves it.
   */
  webDistDir?: string;
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

  // Serve the built web app from the same origin when a bundle is present
  // (production/Docker). Registered last so it never shadows the API; missing
  // static files fall through to the SPA fallback below.
  if (dependencies.webDistDir && existsSync(dependencies.webDistDir)) {
    await app.register(fastifyStatic, {
      root: dependencies.webDistDir,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !request.url.startsWith("/api") &&
        !request.url.startsWith("/health")
      ) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not Found" });
    });
  }

  return app;
}
