import { z } from "zod";
import {
  publicArenaEventSchema,
  type PublicArenaEvent,
} from "../core/events.js";
import type { EventAdapter, RunCorrelation } from "./event-adapter.js";
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
 * AG-UI adapter (differentiator, vision §2/§5.3): the two arena slots become two
 * concurrent AG-UI text messages inside one run. Slot identity is carried in
 * `messageId` as `<matchupId>:<slot>` — the normative channel clients must parse
 * to route each side to its own column — because conformant AG-UI parsers strip
 * the advisory top-level `slot` field. We emit the subset of the AG-UI event
 * taxonomy the arena needs — lifecycle (`RUN_STARTED`/`RUN_FINISHED`/
 * `RUN_ERROR`), text streaming (`TEXT_MESSAGE_START`/`_CONTENT`/`_END`), and
 * `CUSTOM` for out-of-taxonomy payloads: the arena matchup metadata (including
 * the signed vote token, so this path is votable without a second channel) and
 * a single-slot error (the surviving slot keeps streaming). Transport is SSE:
 * one `data:` line per typed event.
 *
 * `RUN_ERROR` is the taxonomy's terminal failure event and the only in-band
 * signal a conformant runtime can settle a pending run on, so arena failures
 * travel through it rather than leaving a run that never reaches
 * `RUN_FINISHED`.
 */

/**
 * `CUSTOM` is AG-UI's escape hatch, so its `value` shape depends entirely on
 * `name`. Nesting a union on `name` inside the outer one keeps each payload
 * strictly typed instead of collapsing them into a loose record.
 */
const agUiCustomEventSchema = z.discriminatedUnion("name", [
  z.object({
    type: z.literal("CUSTOM"),
    name: z.literal("arena_matchup"),
    value: z.object({
      matchupId: z.string(),
      // POST /api/arena/vote is unreachable without this token; AG-UI's own
      // taxonomy has no field for it, hence the CUSTOM carrier. Absent on a
      // non-votable round, which has no token to give.
      matchupToken: z.string().optional(),
      slots: z.array(z.enum(["A", "B"])),
      // A `single` round starts one message and carries no vote token, so a
      // client needs these to decide whether to render vote controls.
      mode: z.enum(["matchup", "single", "shadow"]),
      votable: z.boolean(),
      // Absent on a round that cannot be continued (nothing was persisted to
      // continue from), so a client never sends back an unusable id.
      conversationId: z.string().optional(),
      turnIndex: z.number().optional(),
    }),
  }),
  z.object({
    type: z.literal("CUSTOM"),
    name: z.literal("slot_error"),
    value: z.object({ slot: z.enum(["A", "B"]), message: z.string() }),
  }),
]);

const agUiEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("RUN_STARTED"),
    threadId: z.string(),
    runId: z.string(),
  }),
  z.object({
    type: z.literal("TEXT_MESSAGE_START"),
    messageId: z.string(),
    role: z.literal("assistant"),
    slot: z.enum(["A", "B"]),
  }),
  z.object({
    type: z.literal("TEXT_MESSAGE_CONTENT"),
    messageId: z.string(),
    delta: z.string(),
    slot: z.enum(["A", "B"]),
  }),
  z.object({
    type: z.literal("TEXT_MESSAGE_END"),
    messageId: z.string(),
    slot: z.enum(["A", "B"]),
  }),
  agUiCustomEventSchema,
  z.object({
    type: z.literal("RUN_FINISHED"),
    threadId: z.string(),
    runId: z.string(),
  }),
  z.object({
    type: z.literal("RUN_ERROR"),
    message: z.string(),
    code: z.string(),
  }),
]);

type AgUiEvent = z.infer<typeof agUiEventSchema>;

/**
 * Normative slot identity: `messageId` is `<matchupId>:<slot>`. Conformant
 * AG-UI parsers whitelist known fields and strip the advisory top-level
 * `slot`, so clients must parse the id (docs/md/integration.md § AG-UI). Keyed
 * on the matchup, never on the echoed `runId`, so a client that minted its own
 * run id can still recover the round from a message.
 */
const messageId = (matchupId: string, slot: "A" | "B"): string =>
  `${matchupId}:${slot}`;

function frame(events: AgUiEvent[]): string {
  return events
    .map((event) => `data: ${JSON.stringify(agUiEventSchema.parse(event))}\n\n`)
    .join("");
}

export function createAgUiAdapter(): EventAdapter {
  let matchupId = "";
  let runId = "";
  let threadId = "";
  let client: RunCorrelation = {};

  return {
    correlate(correlation: RunCorrelation): void {
      client = correlation;
    },
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
    inBandErrors: true,
    serialize(event: PublicArenaEvent): string {
      publicArenaEventSchema.parse(event);
      switch (event.type) {
        case "matchup_started": {
          matchupId = event.matchupId;
          // AG-UI's contract is that a server echoes the ids the client sent,
          // and clients key their own run state off them. The arena's ids are
          // the fallback for a client that minted none, and they keep
          // identifying the round either way: `messageId` stays
          // `<matchupId>:<slot>` (the channel every consumer parses the slot
          // out of), and the matchup metadata below carries the ids in full.
          runId = client.runId ?? event.matchupId;
          // A round with no persisted conversation has no thread of its own,
          // so the run stands alone under its own id rather than borrowing an
          // id nothing can continue.
          threadId = client.threadId ?? event.conversationId ?? event.matchupId;
          return frame([
            { type: "RUN_STARTED", threadId, runId },
            {
              type: "CUSTOM",
              name: "arena_matchup",
              value: {
                matchupId: event.matchupId,
                matchupToken: event.matchupToken,
                slots: event.slots,
                mode: event.mode,
                votable: event.votable,
                conversationId: event.conversationId,
                turnIndex: event.turnIndex,
              },
            },
            ...event.slots.map(
              (slot): AgUiEvent => ({
                type: "TEXT_MESSAGE_START",
                messageId: messageId(matchupId, slot),
                role: "assistant",
                slot,
              }),
            ),
          ]);
        }
        case "token":
          return frame([
            {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: messageId(matchupId, event.slot),
              delta: event.token,
              slot: event.slot,
            },
          ]);
        case "slot_error":
          // Mainstream runtimes drop `CUSTOM` (assistant-ui's aggregator has no
          // case for it), so the structured event alone renders a failed slot as
          // a permanently blank column. The marked text goes out on the slot's
          // own message too, which every AG-UI client does render.
          return frame([
            {
              type: "CUSTOM",
              name: "slot_error",
              value: { slot: event.slot, message: event.message },
            },
            {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: messageId(matchupId, event.slot),
              delta: slotErrorText(event.message),
              slot: event.slot,
            },
          ]);
        case "slot_done":
          return frame([
            {
              type: "TEXT_MESSAGE_END",
              messageId: messageId(matchupId, event.slot),
              slot: event.slot,
            },
          ]);
        case "run_error":
          return frame([
            { type: "RUN_ERROR", message: event.message, code: event.code },
          ]);
        case "matchup_done":
          return frame([{ type: "RUN_FINISHED", threadId, runId }]);
      }
    },
    finalize(): string {
      return "";
    },
  };
}

/**
 * `RunAgentInput`, the body every AG-UI client posts. `HttpAgent`,
 * `useAGUIRuntime`, CopilotKit and LangGraph all build this and nothing else, so
 * accepting it is what makes `new HttpAgent({ url })` a working OmniArena client
 * with no subclass in between. Only the members the arena reads are typed;
 * `state`, `tools` and `context` travel with every run and are ignored.
 *
 * `forwardedProps` is AG-UI's sanctioned free-form channel and therefore where
 * the arena's own inputs live. `threadId` is deliberately *not* mapped onto
 * `conversationId`: clients mint their own thread ids (assistant-ui mints a
 * UUID), so treating one as an arena conversation would answer the very first
 * turn of every stock client with `404 Conversation not found`.
 */
const runAgentInputSchema = z.object({
  threadId: z.string().optional(),
  runId: z.string().optional(),
  messages: z.array(protocolMessageSchema),
  forwardedProps: arenaPropsSchema.nullish(),
});

export const agUiRequestAdapter: RequestAdapter = {
  claims: isProtocolEnvelope,
  parse(body: unknown): RequestParseResult {
    const parsed = runAgentInputSchema.safeParse(body);
    if (!parsed.success) {
      return invalidRequest(parsed.error);
    }
    const result = toArenaChatRequest(
      lastUserPrompt(parsed.data.messages),
      parsed.data.forwardedProps,
      "messages",
    );
    return result.ok
      ? {
          ...result,
          correlation: {
            threadId: parsed.data.threadId,
            runId: parsed.data.runId,
          },
        }
      : result;
  },
};
