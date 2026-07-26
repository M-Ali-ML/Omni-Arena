import { randomUUID } from "node:crypto";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import type { EventAdapter } from "../adapters/event-adapter.js";
import { selectProtocol } from "../adapters/registry.js";
import { parseChatRequest } from "../adapters/request-adapter.js";
import type { JoinBroker, JoinSession } from "../arena/join.js";
import { asJoinFailure, JoinedRound } from "../arena/join.js";
import type { ArenaModeConfig } from "../arena/mode.js";
import { resolveArenaPlan } from "../arena/mode.js";
import type { MatchupRegistry } from "../control/registry.js";
import type { ArenaCore } from "../core/arena.js";
import type { ArenaEvent, PublicArenaEvent } from "../core/events.js";
import { toPublicEvent } from "../core/events.js";
import type {
  ChatMessage,
  MatchmakingPort,
  MatchupAssignment,
  Model,
  PreferenceRepositoryPort,
} from "../core/ports.js";
import { ConversationConflictError } from "../repo/postgres.js";
import type { MatchupTokenService } from "../token.js";

const chatQuery = z.object({ protocol: z.string().optional() });

export interface ChatRouteDependencies {
  core: ArenaCore;
  matchmaker: MatchmakingPort;
  repository: PreferenceRepositoryPort;
  tokens: MatchupTokenService;
  registry: MatchupRegistry;
  /** Pairs sibling requests that opt in with `joinKey` into one matchup. */
  joinBroker: JoinBroker;
  harnessVersion: string;
  modeConfig: ArenaModeConfig;
  /** Injectable RNG for the resolver (Phase 2 sampled trigger); defaults to Math.random. */
  rng?: () => number;
}

interface StreamOptions {
  reply: FastifyReply;
  adapter: EventAdapter;
  registry: MatchupRegistry;
  /** Control-plane handle for this stream; also the emitted `matchupId`. */
  streamId: string;
  started: PublicArenaEvent;
  open: (signal: AbortSignal) => AsyncIterable<ArenaEvent>;
  /** Persistence hook, awaited before the event reaches the wire. */
  onEvent?: (event: ArenaEvent) => Promise<void>;
  log: FastifyBaseLogger;
}

/**
 * Deliver a failure that happens before any bytes are written. Protocols whose
 * clients only understand in-band errors get a 200 stream carrying a single
 * terminal `run_error`; everyone else keeps the documented HTTP status.
 */
function fail(
  reply: FastifyReply,
  adapter: EventAdapter,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  if (!adapter.inBandErrors) {
    return reply.code(status).send({ error: message });
  }
  reply.hijack();
  reply.raw.writeHead(200, adapter.headers);
  reply.raw.write(adapter.serialize({ type: "run_error", code, message }));
  const tail = adapter.finalize();
  if (tail) {
    reply.raw.write(tail);
  }
  reply.raw.end();
  return reply;
}

/**
 * The round's metadata, repeated as a response header.
 *
 * Every protocol already carries this on the wire, but three of the runtimes
 * the arena exists to serve never surface it: assistant-ui's AG-UI aggregator
 * drops `CUSTOM` events wholesale, so on the convenience path
 * (`useAgUiRuntime({ url })`) the vote token reaches the client and dies there.
 * A header is readable by anything that can see the response — a fetch wrapper,
 * a Next.js route handler, a proxy — with no cooperation from the runtime that
 * owns the stream. The value is ids, enums, and booleans only, so it stays
 * header-safe ASCII; the browser needs it in `Access-Control-Expose-Headers`
 * (see `app.ts`).
 */
export const MATCHUP_HEADER = "x-arena-matchup";

function matchupHeader(started: PublicArenaEvent): Record<string, string> {
  if (started.type !== "matchup_started") {
    return {};
  }
  const { type: _type, ...metadata } = started;
  return { [MATCHUP_HEADER]: JSON.stringify(metadata) };
}

/**
 * Hijack the response and stream one round through the selected adapter. The
 * response is committed at 200 from the first write on, so a failure part-way
 * through can only be reported in-band: without the `run_error` below the
 * stream would simply stop, with neither `matchup_done` nor an error, and a
 * client would wait forever.
 */
async function streamRound(options: StreamOptions): Promise<void> {
  const { reply, adapter, registry, streamId, started, open, onEvent, log } =
    options;
  reply.hijack();
  reply.raw.writeHead(200, { ...adapter.headers, ...matchupHeader(started) });
  reply.raw.write(adapter.serialize(started));

  const controller = registry.register(streamId);
  try {
    for await (const event of open(controller.signal)) {
      await onEvent?.(event);
      reply.raw.write(adapter.serialize(toPublicEvent(event)));
    }
  } catch (caught) {
    log.error({ err: caught, streamId }, "arena stream failed mid-run");
    reply.raw.write(
      adapter.serialize({
        type: "run_error",
        code: "stream_failed",
        message:
          caught instanceof Error ? caught.message : "Arena stream failed",
      }),
    );
  } finally {
    registry.release(streamId);
    const tail = adapter.finalize();
    if (tail) {
      reply.raw.write(tail);
    }
    reply.raw.end();
  }
}

/**
 * OpenAI clients are configured with a base URL, not a path: they append
 * `/chat/completions` themselves and cannot be pointed at
 * `/api/arena/chat?protocol=openai`. Serving the arena there — as the roster
 * already is at `/v1/models` — is what makes a stock OpenAI client drop-in.
 * Both prefixes are served because a deployment may configure the arena origin
 * with or without `/v1`.
 */
export const OPENAI_CHAT_PATHS = ["/chat/completions", "/v1/chat/completions"];

export function registerChatRoute(
  app: FastifyInstance,
  dependencies: ChatRouteDependencies,
): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    // Selected up front so even a rejected request is answered in the protocol
    // the caller asked for. On the OpenAI paths the protocol is implied by the
    // path itself, since a client that appended `/chat/completions` to a base
    // URL cannot also add `?protocol=`.
    const query = chatQuery.safeParse(request.query);
    const pathProtocol = OPENAI_CHAT_PATHS.includes(
      request.routeOptions.url ?? "",
    )
      ? "openai"
      : undefined;
    const protocol = selectProtocol(
      (query.success ? query.data.protocol : undefined) ?? pathProtocol,
      request.headers.accept,
    );
    const { adapter } = protocol;

    // Either OmniArena's own body or the selected protocol's native envelope —
    // whichever the caller sent. Both arrive here as one validated shape.
    const parsed = parseChatRequest(request.body, protocol.request);
    if (!parsed.ok) {
      const { fieldErrors } = parsed;
      if (adapter.inBandErrors) {
        // An in-band error carries one message, so name the offending fields
        // instead of dropping the detail the JSON path gives.
        return fail(
          reply,
          adapter,
          400,
          "invalid_request",
          `Invalid request: ${Object.keys(fieldErrors).join(", ")}`,
        );
      }
      return reply
        .code(400)
        .send({ error: "Invalid request", details: fieldErrors });
    }

    if (parsed.correlation) {
      adapter.correlate?.(parsed.correlation);
    }

    const input = parsed.request;
    const sessionId = input.sessionId ?? null;

    const headerValue = request.headers["x-arena"];
    const plan = resolveArenaPlan(
      dependencies.modeConfig,
      {
        arena: input.arena,
        header: Array.isArray(headerValue) ? headerValue[0] : headerValue,
      },
      dependencies.rng,
    );

    if (plan.kind === "single") {
      const models = await dependencies.repository.listEnabledModels();
      const model = models.find(
        (candidate) => candidate.id === dependencies.modeConfig.defaultModel,
      );
      if (!model) {
        return fail(
          reply,
          adapter,
          500,
          "default_model_missing",
          `ARENA_DEFAULT_MODEL '${dependencies.modeConfig.defaultModel ?? ""}' is not in the enabled roster`,
        );
      }

      // A single round persists nothing, so it mints no vote token and no
      // conversation: the only id it emits is the one that identifies this
      // stream to the control plane.
      const streamId = randomUUID();
      return streamRound({
        reply,
        adapter,
        registry: dependencies.registry,
        streamId,
        started: {
          type: "matchup_started",
          matchupId: streamId,
          slots: ["A"],
          mode: "single",
          votable: false,
        },
        open: (signal) =>
          dependencies.core.stream(
            [{ role: "user", content: input.prompt }],
            { A: model },
            signal,
          ),
        log: request.log,
      });
    }

    // Slot join. Resolved before any work the sibling must not repeat: the
    // follower never reads the conversation, calls the matchmaker, or writes a
    // matchup row — it mirrors the leader's slot B.
    let joinSession: JoinSession | null = null;
    if (input.joinKey !== undefined && dependencies.joinBroker.enabled) {
      // A join is authorised by its whole scope (session + conversation +
      // prompt), so an unscoped one is refused rather than silently downgraded:
      // without a session the scope would collapse to a client-chosen string
      // that any third party could guess and attach to.
      if (!sessionId) {
        return fail(
          reply,
          adapter,
          400,
          "join_requires_session",
          "A joinKey requires sessionId: a join is scoped to the anonymous session",
        );
      }

      const claim = dependencies.joinBroker.claim({
        joinKey: input.joinKey,
        sessionId,
        conversationId: input.conversationId ?? null,
        prompt: input.prompt,
      });

      if (claim.kind === "exhausted") {
        return fail(
          reply,
          adapter,
          409,
          "join_slots_exhausted",
          "Both slots of this matchup are already claimed; a matchup is a pair",
        );
      }
      if (claim.kind === "expired") {
        return fail(
          reply,
          adapter,
          409,
          "join_expired",
          "The join window closed before this request arrived",
        );
      }
      if (claim.kind === "unavailable") {
        return fail(
          reply,
          adapter,
          503,
          "join_unavailable",
          "Too many unpaired joins in flight; retry without joinKey",
        );
      }

      if (claim.kind === "follower") {
        let joined: Awaited<ReturnType<JoinSession["accept"]>>;
        try {
          joined = await claim.session.accept();
        } catch (error) {
          const failure = asJoinFailure(error);
          return fail(
            reply,
            adapter,
            failure.status,
            failure.code,
            failure.message,
          );
        }
        // Its own control-plane handle, so stopping this connection does not
        // stop the shared generation the leader is persisting.
        const followerStreamId = randomUUID();
        // A sibling that hangs up releases its channel at once; slot B keeps
        // running on the leader's pump and is still recorded.
        reply.raw.on("close", () =>
          dependencies.registry.stop(followerStreamId),
        );
        return streamRound({
          reply,
          adapter,
          registry: dependencies.registry,
          streamId: followerStreamId,
          started: {
            type: "matchup_started",
            matchupId: joined.handshake.matchupId,
            matchupToken: joined.handshake.matchupToken,
            conversationId: joined.handshake.conversationId,
            turnIndex: joined.handshake.turnIndex,
            slots: ["B"],
            mode: "matchup",
            votable: true,
          },
          open: (signal) => joined.round.slot("B", signal),
          log: request.log,
        });
      }

      joinSession = claim.session;
    }

    /**
     * Wait for the sibling, but only as long as the window. On expiry the round
     * degrades to exactly today's shape — both slots on this one connection,
     * votable, nothing wasted — which is the only outcome that keeps the vote
     * honest, because the user sees both answers either way.
     */
    const paired = joinSession ? await joinSession.sibling() : false;

    /** Fail both siblings identically when the leader cannot start the round. */
    const reject = (
      status: number,
      code: string,
      message: string,
    ): FastifyReply => {
      joinSession?.fail({ status, code, message });
      return fail(reply, adapter, status, code, message);
    };

    let conversationId = input.conversationId ?? randomUUID();
    let turnIndex = 0;
    let parentResponseId: string | null = null;
    let history: ChatMessage[] = [];

    if (input.conversationId) {
      const context = await dependencies.repository.getConversationContext(
        input.conversationId,
        sessionId,
      );
      if (context.status === "not_found") {
        return reject(404, "conversation_not_found", "Conversation not found");
      }
      if (context.status === "forbidden") {
        return reject(
          403,
          "conversation_forbidden",
          "Conversation session mismatch",
        );
      }
      if (context.status === "not_ready") {
        return reject(
          409,
          "conversation_not_ready",
          "Vote for a winning response before continuing this conversation",
        );
      }
      conversationId = context.conversationId;
      turnIndex = context.nextTurnIndex;
      parentResponseId = context.parentResponseId;
      history = context.messages;
    }

    let assignment: MatchupAssignment;
    try {
      assignment = await dependencies.matchmaker.pick();
    } catch (error) {
      joinSession?.fail(asJoinFailure(error));
      throw error;
    }
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
        prompt: input.prompt,
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
        return reject(409, "conversation_conflict", error.message);
      }
      joinSession?.fail(asJoinFailure(error));
      throw error;
    }

    const messages: ChatMessage[] = [
      ...history,
      { role: "user", content: input.prompt },
    ];
    const slotModel: Record<"A" | "B", Model> = {
      A: assignment.slotA,
      B: assignment.slotB,
    };

    const persist = async (event: ArenaEvent): Promise<void> => {
      if (event.type !== "slot_done") {
        return;
      }
      await dependencies.repository.saveResponse({
        matchupId,
        slot: event.slot,
        modelId: slotModel[event.slot].id,
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
    };

    const started: PublicArenaEvent = {
      type: "matchup_started",
      matchupId,
      matchupToken: issuedToken.token,
      conversationId,
      turnIndex,
      // The sibling renders slot B, so this connection announces only its own.
      slots: paired ? ["A"] : ["A", "B"],
      mode: "matchup",
      votable: true,
    };

    if (joinSession && paired) {
      // One generation, one matchup row, one vote — demultiplexed into a
      // channel per slot. The leader owns the pump and all persistence, so
      // slot B completes and is recorded even if the sibling disconnects.
      const round = new JoinedRound(
        (signal) => dependencies.core.stream(messages, slotModel, signal),
        persist,
        dependencies.joinBroker.maxQueuedEvents,
      );
      joinSession.publish(
        {
          matchupId,
          matchupToken: issuedToken.token,
          conversationId,
          turnIndex,
        },
        round,
      );
      return streamRound({
        reply,
        adapter,
        registry: dependencies.registry,
        streamId: matchupId,
        started,
        open: (signal) => {
          round.start(signal);
          return round.slot("A", signal);
        },
        log: request.log,
      });
    }

    return streamRound({
      reply,
      adapter,
      registry: dependencies.registry,
      streamId: matchupId,
      started,
      open: (signal) =>
        dependencies.core.stream(messages, slotModel, signal),
      onEvent: persist,
      log: request.log,
    });
  };

  app.post("/api/arena/chat", handler);
  for (const path of OPENAI_CHAT_PATHS) {
    app.post(path, handler);
  }
}
