import { existsSync } from "node:fs";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { JoinBroker } from "./arena/join.js";
import type { ArenaModeConfig } from "./arena/mode.js";
import { MatchupRegistry } from "./control/registry.js";
import type { ArenaCore } from "./core/arena.js";
import type {
  AnalyticsPort,
  LeaderboardPort,
  MatchmakingPort,
  PreferenceRepositoryPort,
} from "./core/ports.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { MATCHUP_HEADER, registerChatRoute } from "./routes/chat.js";
import { registerControlRoute } from "./routes/control.js";
import { registerConversationRoute } from "./routes/conversations.js";
import { registerLeaderboardRoute } from "./routes/leaderboard.js";
import { registerMatchupRoute } from "./routes/matchups.js";
import { registerModelsRoute } from "./routes/models.js";
import { registerVoteRoute } from "./routes/vote.js";
import type { MatchupTokenService } from "./token.js";

export interface AppDependencies {
  core: ArenaCore;
  matchmaker: MatchmakingPort;
  repository: PreferenceRepositoryPort & LeaderboardPort;
  /**
   * Aggregate stats for the insights dashboard. Optional so existing callers
   * (and focused tests) that only exercise the chat/vote flow keep working;
   * the analytics routes are simply absent when omitted.
   */
  analytics?: AnalyticsPort;
  tokens: MatchupTokenService;
  harnessVersion: string;
  /**
   * Trigger/exposure config. Defaults to `always` (today's behavior) when
   * omitted so callers that predate arena modes are unaffected.
   */
  modeConfig?: ArenaModeConfig;
  /** Injectable RNG for the arena-plan resolver; defaults to Math.random. */
  rng?: () => number;
  /** Shared in-flight matchup tracker for the WS control plane; created if absent. */
  registry?: MatchupRegistry;
  /**
   * Pairs sibling requests carrying the same `joinKey` into one matchup.
   * Created with default settings when omitted; joining is opt-in per request,
   * so its presence changes nothing for a client that never sends a `joinKey`.
   */
  joinBroker?: JoinBroker;
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
    // A browser hides every non-safelisted response header unless it is named
    // here, which would make the matchup header invisible to exactly the
    // fetch-level wrappers it exists for.
    exposedHeaders: [MATCHUP_HEADER],
  });
  await app.register(websocket);

  const registry = dependencies.registry ?? new MatchupRegistry();
  const joinBroker = dependencies.joinBroker ?? new JoinBroker();
  const modeConfig = dependencies.modeConfig ?? {
    trigger: "always" as const,
    exposure: "blind" as const,
    defaultModel: null,
    sampleRate: 0,
  };

  app.get("/health", async () => ({ status: "ok" }));
  registerChatRoute(app, { ...dependencies, registry, joinBroker, modeConfig });
  registerVoteRoute(app, dependencies);
  registerMatchupRoute(app, dependencies);
  registerConversationRoute(app, dependencies);
  registerLeaderboardRoute(app, dependencies.repository);
  registerModelsRoute(app, dependencies.repository);
  if (dependencies.analytics) {
    registerAnalyticsRoutes(app, dependencies.analytics);
  }
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
      if (request.method === "GET" && !isApiPath(request.url)) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not Found" });
    });
  }

  return app;
}

/**
 * Paths the SPA fallback must never answer with `index.html`. An unmatched API
 * path served as HTML at status 200 is worse than a 404: Open WebUI's probe of
 * `GET /v1/models` reported `Attempt to decode JSON with unexpected mimetype:
 * text/html` and an empty model picker, with nothing pointing at the route
 * being absent. Anything outside this list is assumed to be a front-end route.
 */
const API_PATH_PREFIXES = [
  "/api",
  "/health",
  "/v1",
  "/models",
  "/chat/completions",
  "/completions",
  "/embeddings",
];

function isApiPath(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return API_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}
