import { z } from "zod";
import {
  publicArenaEventSchema,
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

/**
 * Vercel AI SDK adapter (ecosystem adapter — docs/md/architecture.md §Egress): speaks the AI SDK UI Message
 * Stream protocol so a stock `useChat` client can consume the arena. Slot A
 * rides the primary text channel (`text-start`/`text-delta`/`text-end`); slot B
 * is multiplexed through custom `data-*` parts (`writer.merge` convention) so a
 * sidecar renderer can paint it beside the main answer. The stream terminates
 * with the protocol's `[DONE]` sentinel, emitted from finalize().
 */
const uiMessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("text-start"), id: z.string() }),
  z.object({ type: z.literal("text-delta"), id: z.string(), delta: z.string() }),
  z.object({ type: z.literal("text-end"), id: z.string() }),
  z.object({
    type: z.literal("data-arena-meta"),
    data: z.object({
      matchupId: z.string(),
      // Carried here (as in native SSE's matchup_started) so an AI SDK client
      // can cast a vote once the round finishes; the reveal endpoint needs it.
      // Absent on a non-votable round, which has no token to give.
      matchupToken: z.string().optional(),
      // Absent on a round that persisted no conversation to continue from.
      conversationId: z.string().optional(),
      turnIndex: z.number().optional(),
      mainSlot: z.literal("A"),
      // Only present when the round actually streams a B column. A `single`
      // round has nothing for a sidecar to paint, so advertising `dataSlot: "B"`
      // would be a lie — omit it the same way matchupToken is omitted.
      dataSlot: z.literal("B").optional(),
      // Trigger/exposure fields from matchup_started. A `single` round streams
      // slot A only and carries no vote token, so a client needs these to
      // decide whether to render the B column and the vote controls.
      mode: z.enum(["matchup", "single", "shadow"]),
      votable: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal("data-arena-b-delta"),
    data: z.object({ text: z.string() }),
  }),
  z.object({
    type: z.literal("data-arena-b-done"),
    data: z.object({}),
  }),
  z.object({
    type: z.literal("data-arena-error"),
    data: z.object({ slot: z.enum(["A", "B"]), message: z.string() }),
  }),
  z.object({
    type: z.literal("data-arena-steered"),
    data: z.object({ instruction: z.string() }),
  }),
  /**
   * The protocol's own terminal error part (as opposed to the per-slot data
   * part above), so a stock `useChat` surfaces the failure and settles.
   */
  z.object({ type: z.literal("error"), errorText: z.string() }),
  z.object({ type: z.literal("finish") }),
]);

type UiMessagePart = z.infer<typeof uiMessagePartSchema>;

function frame(parts: UiMessagePart[]): string {
  return parts
    .map(
      (part) => `data: ${JSON.stringify(uiMessagePartSchema.parse(part))}\n\n`,
    )
    .join("");
}

export function createVercelAiAdapter(): EventAdapter {
  let textId = "";

  return {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-vercel-ai-ui-message-stream": "v1",
    },
    serialize(event: PublicArenaEvent): string {
      publicArenaEventSchema.parse(event);
      switch (event.type) {
        case "matchup_started":
          textId = event.matchupId;
          return frame([
            { type: "start" },
            {
              type: "data-arena-meta",
              data: {
                matchupId: event.matchupId,
                matchupToken: event.matchupToken,
                conversationId: event.conversationId,
                turnIndex: event.turnIndex,
                mainSlot: "A",
                dataSlot: event.slots.includes("B") ? "B" : undefined,
                mode: event.mode,
                votable: event.votable,
              },
            },
            { type: "text-start", id: textId },
          ]);
        case "token":
          return event.slot === "A"
            ? frame([{ type: "text-delta", id: textId, delta: event.token }])
            : frame([
                { type: "data-arena-b-delta", data: { text: event.token } },
              ]);
        case "slot_error":
          return frame([
            {
              type: "data-arena-error",
              data: { slot: event.slot, message: event.message },
            },
          ]);
        case "slot_done":
          return event.slot === "A"
            ? frame([{ type: "text-end", id: textId }])
            : frame([{ type: "data-arena-b-done", data: {} }]);
        case "steered":
          return frame([
            {
              type: "data-arena-steered",
              data: { instruction: event.instruction },
            },
          ]);
        case "run_error":
          return frame([
            { type: "error", errorText: `${event.code}: ${event.message}` },
          ]);
        case "matchup_done":
          return frame([{ type: "finish" }]);
      }
    },
    finalize(): string {
      return "data: [DONE]\n\n";
    },
  };
}

/**
 * The body `useChat` posts. AI SDK v5 sends UIMessages whose text lives in
 * `parts`, v4 sent `content`; both are read. The arena's own inputs are read
 * from the top level because that is where `useChat({ body })` puts extra
 * fields, so `useChat({ api: "…?protocol=vercel", body: { sessionId } })` needs
 * no server route of its own. `id`, `trigger` and `messageId` ride along on
 * every request and are ignored.
 */
const useChatRequestSchema = arenaPropsSchema.extend({
  id: z.string().optional(),
  messages: z.array(protocolMessageSchema),
});

export const vercelAiRequestAdapter: RequestAdapter = {
  claims: isProtocolEnvelope,
  parse(body: unknown): RequestParseResult {
    const parsed = useChatRequestSchema.safeParse(body);
    if (!parsed.success) {
      return invalidRequest(parsed.error);
    }
    const { messages, id: _id, ...props } = parsed.data;
    return toArenaChatRequest(lastUserPrompt(messages), props, "messages");
  },
};
