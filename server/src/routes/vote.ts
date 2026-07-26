import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isContinuable, revealOf } from "../arena/outcome.js";
import type { PreferenceRepositoryPort } from "../core/ports.js";
import { DuplicateVoteError } from "../repo/postgres.js";
import type { MatchupTokenService } from "../token.js";

const voteRequest = z.object({
  matchupId: z.string().uuid(),
  matchupToken: z.string().min(1),
  vote: z.enum(["left", "right", "both_good", "both_bad", "skip"]),
});

export function registerVoteRoute(
  app: FastifyInstance,
  dependencies: {
    repository: PreferenceRepositoryPort;
    tokens: MatchupTokenService;
  },
): void {
  app.post("/api/arena/vote", async (request, reply) => {
    const parsed = voteRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid vote request" });
    }

    let claims;
    try {
      claims = dependencies.tokens.verify(parsed.data.matchupToken);
    } catch (error) {
      return reply.code(401).send({
        error: error instanceof Error ? error.message : "Invalid matchup token",
      });
    }

    const matchup = await dependencies.repository.getMatchup(
      parsed.data.matchupId,
    );
    if (!matchup) {
      return reply.code(404).send({ error: "Matchup not found" });
    }
    if (
      claims.matchupId !== matchup.id ||
      claims.slotAModelId !== matchup.slotA.id ||
      claims.slotBModelId !== matchup.slotB.id ||
      !dependencies.tokens.matchesHash(
        parsed.data.matchupToken,
        matchup.matchupTokenHash,
      )
    ) {
      return reply.code(401).send({ error: "Invalid matchup token" });
    }

    const winnerModelId =
      parsed.data.vote === "left"
        ? matchup.slotA.id
        : parsed.data.vote === "right"
          ? matchup.slotB.id
          : null;

    try {
      await dependencies.repository.recordPreference({
        matchupId: matchup.id,
        vote: parsed.data.vote,
        winnerModelId,
        positionBiasMeta: {
          selectedSlot:
            parsed.data.vote === "left"
              ? "A"
              : parsed.data.vote === "right"
                ? "B"
                : null,
        },
        anonymousSessionId: claims.sessionId,
      });
    } catch (error) {
      if (error instanceof DuplicateVoteError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }

    return {
      accepted: true,
      models: revealOf(matchup.slotA, matchup.slotB),
      // Whether this vote left a winning response to continue from, and the id
      // to continue with. Without them every client re-encoded the
      // `left|right ⇒ decisive` rule itself and paid for a wrong guess with a
      // `409` on the next turn.
      continuable: isContinuable(parsed.data.vote),
      conversationId: matchup.conversationId,
    };
  });
}
