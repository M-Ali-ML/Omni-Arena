import type { FastifyInstance } from "fastify";
import type { LeaderboardPort } from "../core/ports.js";

export function registerLeaderboardRoute(
  app: FastifyInstance,
  leaderboard: LeaderboardPort,
): void {
  app.get("/api/arena/leaderboard", async () => ({
    models: await leaderboard.getLeaderboard(),
  }));
}
