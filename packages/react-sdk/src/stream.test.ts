import { describe, expect, it } from "vitest";
import { createArenaSseDecoder, readArenaStream } from "./stream.js";

const encoder = new TextEncoder();

function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("createArenaSseDecoder", () => {
  it("emits one event per frame and keeps a partial frame buffered", () => {
    const decoder = createArenaSseDecoder();

    expect(
      decoder.push('event: token\ndata: {"type":"token","token":"He"}\n\n'),
    ).toEqual([{ type: "token", token: "He" }]);
    expect(decoder.push('data: {"type":"token",')).toEqual([]);
    expect(decoder.push('"token":"llo"}\n\n')).toEqual([
      { type: "token", token: "llo" },
    ]);
  });

  it("joins multi-line data, tolerates CRLF, and skips the done sentinel", () => {
    const decoder = createArenaSseDecoder();

    expect(
      decoder.push(
        'data: {"type":"token",\r\ndata: "token":"x"}\r\n\r\n: comment\n\ndata: [DONE]\n\n',
      ),
    ).toEqual([{ type: "token", token: "x" }]);
  });

  it("splits a multi-byte character across chunks", () => {
    const decoder = createArenaSseDecoder();
    const bytes = encoder.encode('data: {"type":"token","token":"é"}\n\n');
    // Split inside the two-byte "é" so the decoder has to hold the lead byte.
    const split = bytes.findIndex((byte) => byte > 0x7f) + 1;

    expect(decoder.push(bytes.slice(0, split))).toEqual([]);
    expect(decoder.push(bytes.slice(split))).toEqual([
      { type: "token", token: "é" },
    ]);
  });

  it("flushes a trailing frame that never got its blank line", () => {
    const decoder = createArenaSseDecoder();

    expect(decoder.push('data: {"type":"matchup_done"}')).toEqual([]);
    expect(decoder.flush()).toEqual([{ type: "matchup_done" }]);
    expect(decoder.flush()).toEqual([]);
  });
});

describe("readArenaStream", () => {
  it("iterates the events of a response body", async () => {
    const response = new Response(
      bodyOf(
        'data: {"type":"matchup_started","matchupId":"m1"}\n\ndata: {"type":"matchup_done"}\n\n',
      ),
    );

    const events = [];
    for await (const event of readArenaStream(response)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "matchup_started", matchupId: "m1" },
      { type: "matchup_done" },
    ]);
  });

  it("accepts a bare stream and rejects a bodyless response", async () => {
    const events = [];
    for await (const event of readArenaStream(
      bodyOf('data: {"type":"matchup_done"}\n\n'),
    )) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "matchup_done" }]);

    const iterator = readArenaStream(new Response(null, { status: 204 }));
    await expect(iterator.next()).rejects.toThrow(
      "The arena response carried no body",
    );
  });
});
