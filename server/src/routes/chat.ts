import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ArenaCore } from "../core/arena.js";
import { toPublicEvent, type PublicArenaEvent } from "../core/events.js";
import type {
  ChatMessage,
  MatchmakingPort,
  PiiScrubberPort,
  PreferenceRepositoryPort,
} from "../core/ports.js";
import { ConversationConflictError } from "../repo/postgres.js";
import type { MatchupTokenService } from "../token.js";

const chatRequest = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  sessionId: z.string().trim().min(1).max(200).optional(),
  conversationId: z.string().uuid().optional(),
});

function writeEvent(
  response: NodeJS.WritableStream,
  event: PublicArenaEvent,
): void {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export interface ChatRouteDependencies {
  core: ArenaCore;
  matchmaker: MatchmakingPort;
  repository: PreferenceRepositoryPort;
  piiScrubber: PiiScrubberPort;
  tokens: MatchupTokenService;
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
    const persistedPrompt = await dependencies.piiScrubber.scrub(
      parsed.data.prompt,
    );
    const issuedToken = dependencies.tokens.issue({
      matchupId,
      slotAModelId: assignment.slotA.id,
      slotBModelId: assignment.slotB.id,
      sessionId,
    });

    try {
      await dependencies.repository.createMatchup({
        id: matchupId,
        prompt: persistedPrompt,
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

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    writeEvent(reply.raw, {
      type: "matchup_started",
      matchupId,
      matchupToken: issuedToken.token,
      conversationId,
      turnIndex,
      slots: ["A", "B"],
    });

    const messages: ChatMessage[] = [
      ...history,
      { role: "user", content: parsed.data.prompt },
    ];
    try {
      for await (const event of dependencies.core.stream(
        messages,
        assignment,
      )) {
        if (event.type === "slot_done") {
          const persistedContent = await dependencies.piiScrubber.scrub(
            event.content,
          );
          await dependencies.repository.saveResponse({
            matchupId,
            slot: event.slot,
            modelId:
              event.slot === "A" ? assignment.slotA.id : assignment.slotB.id,
            content: persistedContent,
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
        writeEvent(reply.raw, toPublicEvent(event));
      }
    } finally {
      reply.raw.end();
    }
  });
}
