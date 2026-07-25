import "server-only";
import type { ArenaMeta, ArenaSlotError } from "./protocol";

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
 * One frame is rewritten: the adapter's `{"type":"start"}` carries no
 * `messageId`, so the client would mint its own id and the row we save would be
 * unreachable from the live message. Injecting the id we persist under keeps
 * the streamed message and the stored message the same entity.
 */
export function createArenaStreamTransform(options: {
  messageId: string;
  onComplete: (result: ArenaStreamResult) => Promise<void> | void;
}): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const result: ArenaStreamResult = {
    errors: [],
    meta: null,
    slotA: "",
    slotB: "",
  };
  let buffer = "";
  let startRewritten = false;

  const observe = (part: SsePart): void => {
    switch (part.type) {
      case "data-arena-meta":
        result.meta = part.data as ArenaMeta;
        break;
      case "text-delta":
        result.slotA += part.delta ?? "";
        break;
      case "data-arena-b-delta":
        result.slotB += (part.data as { text?: string } | undefined)?.text ?? "";
        break;
      case "data-arena-error":
        result.errors.push(part.data as ArenaSlotError);
        break;
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
        observe(part);
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
      const tail = buffer + decoder.decode();
      if (tail.length > 0) {
        controller.enqueue(encoder.encode(rewriteFrame(tail)));
      }
      await options.onComplete(result);
    },
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        controller.enqueue(encoder.encode(`${rewriteFrame(frame)}\n\n`));
        boundary = buffer.indexOf("\n\n");
      }
    },
  });
}
