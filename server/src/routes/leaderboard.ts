import type { FastifyInstance } from "fastify";
import type { LeaderboardPort } from "../core/ports.js";

/**
 * The leaderboard and the context that makes it readable, in one response
 * (vision §3, §4).
 *
 * `components` and `styleControl` are additive siblings of the pre-existing
 * `models` array rather than a separate endpoint: neither is meaningful on its
 * own, and connectivity in particular *qualifies* the ratings — a client that
 * fetched `models` alone would render numbers it cannot know are comparable.
 * Keeping them in one payload means there is no request a client can make that
 * returns an unqualified leaderboard. Existing clients read `models` and are
 * unaffected.
 */
export function registerLeaderboardRoute(
  app: FastifyInstance,
  leaderboard: LeaderboardPort,
): void {
  app.get("/api/arena/leaderboard", async () => {
    const [models, context] = await Promise.all([
      leaderboard.getLeaderboard(),
      leaderboard.getRatingContext(),
    ]);
    return { models, ...context };
  });
}
