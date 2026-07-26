import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isContinuable, revealIfVoted } from "../arena/outcome.js";
import type { PreferenceRepositoryPort } from "../core/ports.js";

const conversationParams = z.object({ conversationId: z.string().uuid() });
const conversationQuery = z.object({
  sessionId: z.string().trim().min(1).max(200).optional(),
});

/**
 * Rehydrate a thread after a reload. The arena has held the conversation
 * server-side all along — prompts, both blind answers per turn, and the vote —
 * but exposed no way to read it, so every host either lost the thread on
 * refresh or rebuilt it from client-only state it had invented (assistant-ui
 * finding 10).
 *
 * The last turn comes back even when it has no vote yet: a pending pair
 * awaiting a decision is precisely the state a reload has to restore.
 */
export function registerConversationRoute(
  app: FastifyInstance,
  dependencies: { repository: PreferenceRepositoryPort },
): void {
  app.get("/api/arena/conversations/:conversationId", async (request, reply) => {
    const params = conversationParams.safeParse(request.params);
    const query = conversationQuery.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "Invalid conversation request" });
    }

    // Unlike the leaderboard and the analytics aggregates, this read returns a
    // caller's own prompts and answers, so it is scoped to the anonymous
    // session that owns the conversation — the same check the chat route makes
    // before continuing one.
    const conversation = await dependencies.repository.getConversationTurns(
      params.data.conversationId,
      query.data.sessionId ?? null,
    );
    if (conversation.status === "not_found") {
      return reply.code(404).send({ error: "Conversation not found" });
    }
    if (conversation.status === "forbidden") {
      return reply.code(403).send({ error: "Conversation session mismatch" });
    }

    const latest = conversation.turns.at(-1);
    return {
      conversationId: conversation.conversationId,
      // What the next turn needs: whether it may pass this `conversationId` at
      // all, and the index it will be given if it does.
      continuable: isContinuable(latest?.vote ?? null),
      nextTurnIndex: latest === undefined ? 0 : latest.turnIndex + 1,
      turns: conversation.turns.map((turn) => ({
        turnIndex: turn.turnIndex,
        matchupId: turn.matchupId,
        prompt: turn.prompt,
        votable: turn.vote === null,
        vote: turn.vote,
        answers: turn.answers,
        models: revealIfVoted(turn),
      })),
    };
  });
}
