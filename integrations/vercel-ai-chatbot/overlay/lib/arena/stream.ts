import "server-only";
import {
  createArenaSseDecoder,
  parseArenaSlotError,
} from "@omni-arena/react";
import {
  arenaMetaFromUnknown,
  type ArenaMeta,
  type ArenaSlotError,
} from "./protocol";

export type ArenaStreamResult = {
  meta: ArenaMeta | null;
  slotA: string;
  slotB: string;
  errors: ArenaSlotError[];
};

type SsePart = { type: string; data?: unknown; delta?: string };

/**
 * Tees OmniArena's UI Message Stream: every frame is forwarded to the browser
 * untouched (so the stock `useChat` client sees exactly what the adapter emits)
 * while slot A/B text is accumulated for persistence.
 *
 * Frame boundaries and JSON payloads are decoded with the SDK's SSE helper;
 * one frame is rewritten: the adapter's `{"type":"start"}` carries no
 * `messageId`, so the client would mint its own id and the row we save would be
 * unreachable from the live message. Injecting the id we persist under keeps
 * the streamed message and the stored message the same entity.
 */
export function createArenaStreamTransform(options: {
  messageId: string;
  /** Prefer this when the stream never emits `data-arena-meta`. */
  headerMeta?: ArenaMeta | null;
  onComplete: (result: ArenaStreamResult) => Promise<void> | void;
}): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = createArenaSseDecoder<SsePart>();
  const result: ArenaStreamResult = {
    errors: [],
    meta: null,
    slotA: "",
    slotB: "",
  };
  let rawBuffer = "";
  const textDecoder = new TextDecoder();
  let startRewritten = false;

  const observe = (part: SsePart): void => {
    switch (part.type) {
      case "data-arena-meta":
        result.meta = arenaMetaFromUnknown(part.data) ?? result.meta;
        break;
      case "text-delta":
        result.slotA += part.delta ?? "";
        break;
      case "data-arena-b-delta":
        result.slotB += (part.data as { text?: string } | undefined)?.text ?? "";
        break;
      case "data-arena-error": {
        const error = parseArenaSlotError(part.data);
        if (error) {
          result.errors.push(error);
        }
        break;
      }
      default:
        break;
    }
  };

  const rewriteFrame = (frame: string): string =>
    frame
      .split("\n")
      .map((line) => {
        if (!line.startsWith("data: ")) {
          return line;
        }
        const payload = line.slice("data: ".length);
        if (payload === "[DONE]") {
          return line;
        }
        let part: SsePart;
        try {
          part = JSON.parse(payload) as SsePart;
        } catch {
          return line;
        }
        if (part.type === "start" && !startRewritten) {
          startRewritten = true;
          return `data: ${JSON.stringify({
            messageId: options.messageId,
            type: "start",
          })}`;
        }
        return line;
      })
      .join("\n");

  return new TransformStream<Uint8Array, Uint8Array>({
    async flush(controller) {
      const trailing = decoder.flush();
      for (const part of trailing) {
        observe(part);
      }
      const tail = rawBuffer + textDecoder.decode();
      if (tail.length > 0) {
        controller.enqueue(encoder.encode(rewriteFrame(tail)));
      }
      if (!result.meta && options.headerMeta) {
        result.meta = options.headerMeta;
      }
      await options.onComplete(result);
    },
    transform(chunk, controller) {
      for (const part of decoder.push(chunk)) {
        observe(part);
      }
      rawBuffer += textDecoder.decode(chunk, { stream: true });
      let boundary = rawBuffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = rawBuffer.slice(0, boundary);
        rawBuffer = rawBuffer.slice(boundary + 2);
        controller.enqueue(encoder.encode(`${rewriteFrame(frame)}\n\n`));
        boundary = rawBuffer.indexOf("\n\n");
      }
    },
  });
}
