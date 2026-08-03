import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  publicArenaEventSchema,
  type ArenaSlot,
  type PublicArenaEvent,
} from "../core/events.js";
import type { EventAdapter } from "./event-adapter.js";
import {
  arenaPropsSchema,
  invalidRequest,
  isProtocolEnvelope,
  lastUserPrompt,
  protocolMessageSchema,
  toArenaChatRequest,
  type RequestAdapter,
  type RequestParseResult,
} from "./request-adapter.js";
import { slotErrorText } from "./slot-error.js";

/**
 * OpenAI SSE adapter (ecosystem adapter — docs/md/architecture.md §Egress): emits `chat.completion.chunk`
 * frames so Open WebUI / Chatbot-UI-class frontends can drive the arena as if
 * it were a normal OpenAI endpoint. finalize() writes the protocol's trailing
 * `data: [DONE]` sentinel.
 *
 * **Why slot A is pinned to `choices[0]` in every frame.** The chunk schema
 * allows more than one entry in `choices` (that is how `n > 1` is expressed),
 * and the entries carry an `index`. But no real client demultiplexes on that
 * index: Open WebUI reads `parsedData.choices?.[0]?.delta?.content` in its
 * SvelteKit parser and `choices[0].get('delta')` in its Python middleware, and
 * langchain-openai likewise takes only the first choice. So a reader is
 * *positional* in practice, and this adapter used to emit one choice per frame
 * with the slot in `index` — which meant a positional reader spliced both
 * models' tokens into one incoherent message, at HTTP 200 with a clean
 * `[DONE]`: a silent corruption.
 *
 * Every frame therefore carries one choice per active slot, in slot order, so
 * `choices[0]` is *always* slot A and a positional reader gets exactly one
 * coherent answer. Slot B rides `choices[1]` of the same frame for a client
 * that does honour `index` (the arena's own Open WebUI bridge does). A slot
 * with nothing to say in a frame gets an empty `delta`, and a slot that has
 * finished keeps its `finish_reason: "stop"` in later frames rather than
 * retracting it.
 *
 * Arena data has no home in OpenAI's contract, so it rides optional top-level
 * extensions — `omni_arena` (matchup metadata, first chunk only) and
 * `omni_arena_error` (a failed slot). OpenAI-compatible clients ignore
 * unrecognized top-level response fields, so this stays drop-in safe while
 * letting an arena-aware client vote and mark a dead column.
 */
const choiceSchema = z.object({
  index: z.number(),
  delta: z.object({
    role: z.literal("assistant").optional(),
    content: z.string().optional(),
  }),
  finish_reason: z.literal("stop").nullable(),
});

const chunkSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion.chunk"),
  created: z.number(),
  model: z.string(),
  choices: z.array(choiceSchema),
  omni_arena: z
    .object({
      matchupId: z.string(),
      matchupToken: z.string().optional(),
      // Multi-turn continuation is driven by these two, so their absence in
      // this adapter used to make the arena's conversation feature unreachable
      // over the protocol with the largest client base.
      conversationId: z.string().optional(),
      turnIndex: z.number().optional(),
      // A `single` round streams one choice and carries no vote token, so a
      // client needs these to decide whether to render vote controls.
      mode: z.enum(["matchup", "single", "shadow"]),
      votable: z.boolean(),
    })
    .optional(),
  /**
   * A failed slot, structurally. The same text also appears in that choice's
   * `delta.content` behind a marker (see `slot-error.ts`), because a plain
   * OpenAI client has no other way to learn the column is dead.
   */
  omni_arena_error: z
    .object({ slot: z.enum(["A", "B"]), message: z.string() })
    .optional(),
  omni_arena_steer: z.object({ instruction: z.string() }).optional(),
});

/**
 * Terminal failure of the run. OpenAI's chunk has no error member, so this
 * follows what OpenAI-compatible servers already do mid-stream: a `data:` frame
 * whose payload is an `error` object, then `[DONE]`.
 */
const errorFrameSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.literal("omni_arena_error"),
    code: z.string(),
  }),
});

type Chunk = z.infer<typeof chunkSchema>;
type Delta = z.infer<typeof choiceSchema>["delta"];
type ChunkExtensions = Pick<
  Chunk,
  "omni_arena" | "omni_arena_error" | "omni_arena_steer"
>;

const slotIndex = (slot: ArenaSlot): number => (slot === "A" ? 0 : 1);

export function createOpenAiSseAdapter(): EventAdapter {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = "omni-arena";
  let activeSlots: ArenaSlot[] = ["A", "B"];
  const finished: Record<ArenaSlot, boolean> = { A: false, B: false };

  /** One frame holding every active slot's choice, slot A first. */
  const frame = (
    deltas: Partial<Record<ArenaSlot, Delta>>,
    extensions: ChunkExtensions = {},
  ): string => {
    const chunk: Chunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: activeSlots.map((slot) => ({
        index: slotIndex(slot),
        delta: deltas[slot] ?? {},
        finish_reason: finished[slot] ? ("stop" as const) : null,
      })),
      ...extensions,
    };
    return `data: ${JSON.stringify(chunkSchema.parse(chunk))}\n\n`;
  };

  return {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
    serialize(event: PublicArenaEvent): string {
      publicArenaEventSchema.parse(event);
      switch (event.type) {
        case "matchup_started": {
          activeSlots = event.slots;
          const openers: Partial<Record<ArenaSlot, Delta>> = {};
          for (const slot of activeSlots) {
            openers[slot] = { role: "assistant" };
          }
          // Absent optional members stay absent on the wire: `JSON.stringify`
          // drops `undefined`, so no client sees an empty-string sentinel.
          return frame(openers, {
            omni_arena: {
              matchupId: event.matchupId,
              matchupToken: event.matchupToken,
              conversationId: event.conversationId,
              turnIndex: event.turnIndex,
              mode: event.mode,
              votable: event.votable,
            },
          });
        }
        case "token":
          return frame({ [event.slot]: { content: event.token } });
        case "slot_error":
          return frame(
            { [event.slot]: { content: slotErrorText(event.message) } },
            { omni_arena_error: { slot: event.slot, message: event.message } },
          );
        case "slot_done":
          finished[event.slot] = true;
          return frame({});
        case "steered":
          return frame(
            {},
            { omni_arena_steer: { instruction: event.instruction } },
          );
        case "run_error":
          return `data: ${JSON.stringify(
            errorFrameSchema.parse({
              error: {
                message: event.message,
                type: "omni_arena_error",
                code: event.code,
              },
            }),
          )}\n\n`;
        case "matchup_done":
          return "";
      }
    },
    finalize(): string {
      return "data: [DONE]\n\n";
    },
  };
}

/**
 * A standard `POST /v1/chat/completions` body. Everything an OpenAI-compatible
 * client sends beyond the four members below (`temperature`, `max_tokens`,
 * `tools`, …) is accepted and ignored: the arena picks the models and the
 * sampling, so honouring those knobs would be a promise it cannot keep, and
 * rejecting them would lock out every real client.
 *
 * `user` is OpenAI's stable end-user identifier and the closest thing the
 * protocol has to the arena's anonymous session, so it seeds `sessionId`. There
 * is no standard home for a conversation id or the arena opt-in, so those ride
 * an `omni_arena` request extension — the mirror of the `omni_arena` extension
 * this adapter writes onto the first chunk.
 */
const chatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(protocolMessageSchema),
  stream: z.boolean().optional(),
  user: z.string().trim().min(1).max(200).optional(),
  omni_arena: arenaPropsSchema.nullish(),
});

export const openAiRequestAdapter: RequestAdapter = {
  claims: isProtocolEnvelope,
  parse(body: unknown): RequestParseResult {
    const parsed = chatCompletionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return invalidRequest(parsed.error);
    }
    // A matchup is two live streams; there is no buffered `chat.completion`
    // object to return. Saying so beats answering a non-streaming request with
    // a stream the client will not read.
    if (parsed.data.stream === false) {
      return {
        ok: false,
        fieldErrors: {
          stream: [
            "Omni-Arena only streams; omit `stream` or set it to true",
          ],
        },
      };
    }
    const extension = parsed.data.omni_arena;
    return toArenaChatRequest(
      lastUserPrompt(parsed.data.messages),
      {
        ...extension,
        sessionId: extension?.sessionId ?? parsed.data.user,
      },
      "messages",
    );
  },
};
