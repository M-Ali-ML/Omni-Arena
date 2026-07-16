import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  publicArenaEventSchema,
  type PublicArenaEvent,
} from "../core/events.js";
import type { EventAdapter } from "./event-adapter.js";

/**
 * OpenAI SSE adapter (ecosystem, vision §2): emits `chat.completion.chunk`
 * frames so Open WebUI / Chatbot-UI-class frontends can drive the arena as if
 * it were a normal OpenAI endpoint. The two slots are mapped onto two `choices`
 * entries (slot A → index 0, slot B → index 1) of one dual-stream completion.
 * A single-slot failure is surfaced inline on that choice while the other keeps
 * streaming. finalize() writes the protocol's trailing `data: [DONE]` sentinel.
 */
const chunkSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion.chunk"),
  created: z.number(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number(),
      delta: z.object({
        role: z.literal("assistant").optional(),
        content: z.string().optional(),
      }),
      finish_reason: z.literal("stop").nullable(),
    }),
  ),
});

type Chunk = z.infer<typeof chunkSchema>;
type Choice = Chunk["choices"][number];

const slotIndex = (slot: "A" | "B"): number => (slot === "A" ? 0 : 1);

export function createOpenAiSseAdapter(): EventAdapter {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = "omni-arena";

  const frame = (choices: Choice[]): string => {
    const chunk: Chunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices,
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
        case "matchup_started":
          return frame(
            event.slots.map((slot) => ({
              index: slotIndex(slot),
              delta: { role: "assistant" as const },
              finish_reason: null,
            })),
          );
        case "token":
          return frame([
            {
              index: slotIndex(event.slot),
              delta: { content: event.token },
              finish_reason: null,
            },
          ]);
        case "slot_error":
          return frame([
            {
              index: slotIndex(event.slot),
              delta: { content: event.message },
              finish_reason: null,
            },
          ]);
        case "slot_done":
          return frame([
            {
              index: slotIndex(event.slot),
              delta: {},
              finish_reason: "stop",
            },
          ]);
        case "matchup_done":
          return "";
      }
    },
    finalize(): string {
      return "data: [DONE]\n\n";
    },
  };
}
