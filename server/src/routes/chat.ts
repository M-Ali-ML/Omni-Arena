import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { selectAdapter } from "../adapters/registry.js";
import type { MatchupRegistry } from "../control/registry.js";
import type { ArenaCore } from "../core/arena.js";
import { toPublicEvent } from "../core/events.js";
import type {
  ChatMessage,
  MatchmakingPort,
  PreferenceRepositoryPort,
} from "../core/ports.js";
import { ConversationConflictError } from "../repo/postgres.js";
import type { MatchupTokenService } from "../token.js";

const chatRequest = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  sessionId: z.string().trim().min(1).max(200).optional(),
  conversationId: z.string().uuid().optional(),
});

const chatQuery = z.object({ protocol: z.string().optional() });

export interface ChatRouteDependencies {
  core: ArenaCore;
  matchmaker: MatchmakingPort;
  repository: PreferenceRepositoryPort;
  tokens: MatchupTokenService;
  registry: MatchupRegistry;
  harnessVersion: string;
}

export function registerChatRoute(
  app: FastifyInstance,
  dependencies: ChatRouteDependencies,
): void {
  app.post("/api/arena/chat", async (request, reply) => {
    const parsed = chatRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const sessionId = parsed.data.sessionId ?? null;
    let conversationId = parsed.data.conversationId ?? randomUUID();
    let turnIndex = 0;
    let parentResponseId: string | null = null;
    let history: ChatMessage[] = [];

    if (parsed.data.conversationId) {
      const context = await dependencies.repository.getConversationContext(
        parsed.data.conversationId,
        sessionId,
      );
      if (context.status === "not_found") {
        return reply.code(404).send({ error: "Conversation not found" });
      }
      if (context.status === "forbidden") {
        return reply.code(403).send({ error: "Conversation session mismatch" });
      }
      if (context.status === "not_ready") {
        return reply.code(409).send({
          error:
            "Vote for a winning response before continuing this conversation",
        });
      }
      conversationId = context.conversationId;
      turnIndex = context.nextTurnIndex;
      parentResponseId = context.parentResponseId;
      history = context.messages;
    }

    const assignment = await dependencies.matchmaker.pick();
    const matchupId = randomUUID();
    const issuedToken = dependencies.tokens.issue({
      matchupId,
      slotAModelId: assignment.slotA.id,
      slotBModelId: assignment.slotB.id,
      sessionId,
    });

    try {
      await dependencies.repository.createMatchup({
        id: matchupId,
        prompt: parsed.data.prompt,
        modelAId: assignment.modelA.id,
        modelBId: assignment.modelB.id,
        slotAModelId: assignment.slotA.id,
        slotBModelId: assignment.slotB.id,
        matchupTokenHash: issuedToken.hash,
        harnessVersion: dependencies.harnessVersion,
        conversation: {
          id: conversationId,
          turnId: randomUUID(),
          turnIndex,
          parentResponseId,
          anonymousSessionId: sessionId,
        },
      });
    } catch (error) {
      if (error instanceof ConversationConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }

    const query = chatQuery.safeParse(request.query);
    const adapter = selectAdapter(
      query.success ? query.data.protocol : undefined,
      request.headers.accept,
    );
    reply.hijack();
    reply.raw.writeHead(200, adapter.headers);

    reply.raw.write(
      adapter.serialize({
        type: "matchup_started",
        matchupId,
        matchupToken: issuedToken.token,
        conversationId,
        turnIndex,
        slots: ["A", "B"],
      }),
    );

    const messages: ChatMessage[] = [
      ...history,
      { role: "user", content: parsed.data.prompt },
    ];
    const controller = dependencies.registry.register(matchupId);
    try {
      for await (const event of dependencies.core.stream(
        messages,
        assignment,
        controller.signal,
      )) {
        if (event.type === "slot_done") {
          await dependencies.repository.saveResponse({
            matchupId,
            slot: event.slot,
            modelId:
              event.slot === "A" ? assignment.slotA.id : assignment.slotB.id,
            content: event.content,
            latencyMs: event.latencyMs,
            ttftMs: event.ttftMs,
            streamDurationMs: event.streamDurationMs,
            outputTokenCount: event.outputTokenCount,
            tokenCountSource: event.tokenCountSource,
            markdownDensity: event.markdownDensity,
            modelVersion: event.modelVersion,
            error: event.error,
          });
        }
        reply.raw.write(adapter.serialize(toPublicEvent(event)));
      }
    } finally {
      dependencies.registry.release(matchupId);
      const tail = adapter.finalize();
      if (tail) {
        reply.raw.write(tail);
      }
      reply.raw.end();
    }
  });
}
