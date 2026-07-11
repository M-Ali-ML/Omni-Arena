import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ArenaCore } from "../core/arena.js";
import { toPublicEvent, type PublicArenaEvent } from "../core/events.js";
import type {
  MatchmakingPort,
  PreferenceRepositoryPort,
} from "../core/ports.js";
import type { MatchupTokenService } from "../token.js";

const chatRequest = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  sessionId: z.string().trim().min(1).max(200).optional(),
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
  tokens: MatchupTokenService;
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

    const assignment = await dependencies.matchmaker.pick();
    const matchupId = randomUUID();
    const issuedToken = dependencies.tokens.issue({
      matchupId,
      slotAModelId: assignment.slotA.id,
      slotBModelId: assignment.slotB.id,
      sessionId: parsed.data.sessionId ?? null,
    });

    await dependencies.repository.createMatchup({
      id: matchupId,
      prompt: parsed.data.prompt,
      modelAId: assignment.modelA.id,
      modelBId: assignment.modelB.id,
      slotAModelId: assignment.slotA.id,
      slotBModelId: assignment.slotB.id,
      matchupTokenHash: issuedToken.hash,
    });

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
      slots: ["A", "B"],
    });

    try {
      for await (const event of dependencies.core.stream(
        parsed.data.prompt,
        assignment,
      )) {
        if (event.type === "slot_done") {
          await dependencies.repository.saveResponse({
            matchupId,
            slot: event.slot,
            modelId:
              event.slot === "A" ? assignment.slotA.id : assignment.slotB.id,
            content: event.content,
            latencyMs: event.latencyMs,
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
