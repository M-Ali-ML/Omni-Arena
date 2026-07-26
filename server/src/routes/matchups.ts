import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isContinuable, revealIfVoted } from "../arena/outcome.js";
import type { PreferenceRepositoryPort } from "../core/ports.js";

const matchupParams = z.object({ matchupId: z.string().uuid() });

/**
 * Read one round back after — or without — its stream. Two clients need this:
 * an AG-UI host whose runtime dropped the `CUSTOM` event the matchup metadata
 * rides on and only kept the `messageId`, and any host that reloaded and has to
 * decide whether the round it is looking at is still open, already voted, or
 * continuable.
 *
 * The matchup token is deliberately **not** returned. It is the capability that
 * authorises a vote, minted once onto the stream that served the round; an
 * unauthenticated read that handed it out would let anyone holding a matchup id
 * vote on a round they never saw. Identities follow the same rule as everywhere
 * else and appear only against a recorded vote.
 */
export function registerMatchupRoute(
  app: FastifyInstance,
  dependencies: { repository: PreferenceRepositoryPort },
): void {
  app.get("/api/arena/matchups/:matchupId", async (request, reply) => {
    const params = matchupParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid matchup id" });
    }

    const matchup = await dependencies.repository.getMatchup(
      params.data.matchupId,
    );
    if (!matchup) {
      return reply.code(404).send({ error: "Matchup not found" });
    }

    return {
      matchupId: matchup.id,
      conversationId: matchup.conversationId,
      turnIndex: matchup.turnIndex,
      // A persisted round is always a matchup — a `single` round writes no row
      // and is therefore never readable here — but the field is carried so the
      // shape matches the metadata the stream emits.
      mode: "matchup",
      votable: matchup.vote === null,
      continuable: isContinuable(matchup.vote),
      vote: matchup.vote,
      models: revealIfVoted(matchup),
    };
  });
}
