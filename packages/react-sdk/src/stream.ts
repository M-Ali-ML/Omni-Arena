import type { ArenaStreamEvent } from "./protocol.js";

/**
 * Incremental SSE decoder for the arena stream. Framework-free and stateless
 * apart from its own buffer, so the same parser serves a browser hook, a server
 * route that tees the stream before persisting it, and a `TransformStream`.
 *
 * Generic over the payload because the adapters reframe the same round: the
 * native protocol emits `ArenaStreamEvent`, `?protocol=vercel-ai` emits UI
 * message stream parts.
 */
export interface ArenaSseDecoder<TEvent> {
  /** Feed a chunk; returns every event completed by it. */
  push(chunk: Uint8Array | string): TEvent[];
  /** Feed the end of the stream; returns any trailing event. */
  flush(): TEvent[];
}

const DONE_SENTINEL = "[DONE]";

/** The `data:` lines of one SSE frame, rejoined into a single payload. */
function frameData(frame: string): string {
  return frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

export function createArenaSseDecoder<
  TEvent = ArenaStreamEvent,
>(): ArenaSseDecoder<TEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  const drain = (frames: string[]): TEvent[] => {
    const events: TEvent[] = [];
    for (const frame of frames) {
      const data = frameData(frame);
      // Some adapters close with `data: [DONE]`, which is not JSON and carries
      // nothing a consumer needs.
      if (data && data !== DONE_SENTINEL) {
        events.push(JSON.parse(data) as TEvent);
      }
    }
    return events;
  };

  return {
    push(chunk) {
      buffer +=
        typeof chunk === "string"
          ? chunk.replace(/\r\n/g, "\n")
          : decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      return drain(frames);
    },
    flush() {
      const tail = (buffer + decoder.decode()).replace(/\r\n/g, "\n");
      buffer = "";
      return drain(tail.split("\n\n"));
    },
  };
}

/**
 * The same decoder as an async iterator over a `Response` (or its body), for
 * consumers that own the request themselves.
 */
export async function* readArenaStream<TEvent = ArenaStreamEvent>(
  source: Response | ReadableStream<Uint8Array>,
): AsyncGenerator<TEvent, void, void> {
  const body = source instanceof ReadableStream ? source : source.body;
  if (!body) {
    throw new Error("The arena response carried no body");
  }
  const reader = body.getReader();
  const decoder = createArenaSseDecoder<TEvent>();
  while (true) {
    const { done, value } = await reader.read();
    for (const event of done
      ? decoder.flush()
      : decoder.push(value ?? new Uint8Array())) {
      yield event;
    }
    if (done) {
      return;
    }
  }
}
