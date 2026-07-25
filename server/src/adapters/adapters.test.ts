import { describe, expect, it } from "vitest";
import type { PublicArenaEvent } from "../core/events.js";
import { createA2uiAdapter } from "./a2ui.js";
import { createAgUiAdapter } from "./ag-ui.js";
import type { EventAdapter } from "./event-adapter.js";
import { createOpenAiSseAdapter } from "./openai-sse.js";
import { selectAdapter, selectProtocol } from "./registry.js";
import { parseChatRequest } from "./request-adapter.js";
import { SLOT_ERROR_MARKER } from "./slot-error.js";
import { sseAdapter } from "./sse.js";
import { createVercelAiAdapter } from "./vercel-ai.js";

interface OpenAiChunk {
  object: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
  omni_arena?: Record<string, unknown>;
  omni_arena_error?: Record<string, unknown>;
}

const started: PublicArenaEvent = {
  type: "matchup_started",
  matchupId: "m1",
  matchupToken: "tok-secret",
  conversationId: "c1",
  turnIndex: 0,
  slots: ["A", "B"],
  mode: "matchup",
  votable: true,
};

const sequence: PublicArenaEvent[] = [
  started,
  { type: "token", slot: "A", token: "He" },
  { type: "token", slot: "B", token: "Yo" },
  { type: "token", slot: "A", token: "llo" },
  { type: "slot_error", slot: "B", message: "boom" },
  { type: "slot_done", slot: "B" },
  { type: "slot_done", slot: "A" },
  { type: "matchup_done" },
];

/** Every emitted `data:` JSON payload across a full serialized stream. */
function dataPayloads(adapter: EventAdapter): unknown[] {
  const body = sequence.map((event) => adapter.serialize(event)).join("");
  return body
    .split(/\n\n/)
    .flatMap((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length)),
    )
    .filter((data) => data.length > 0 && data !== "[DONE]")
    .map((data) => JSON.parse(data) as unknown);
}

/** The `data:` payloads of one already-serialized frame. */
function frameEvents(
  frame: string,
): Array<Record<string, unknown> & { name?: string; value?: unknown }> {
  return frame
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map(
      (line) =>
        JSON.parse(line.slice("data: ".length)) as Record<string, unknown>,
    );
}

function ndjsonMessages(adapter: EventAdapter): unknown[] {
  const body = sequence.map((event) => adapter.serialize(event)).join("");
  return body
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

describe("native SSE adapter (default path)", () => {
  it("frames events byte-for-byte as before", () => {
    expect(sseAdapter.serialize({ type: "token", slot: "A", token: "x" })).toBe(
      'event: token\ndata: {"type":"token","slot":"A","token":"x"}\n\n',
    );
    expect(sseAdapter.finalize()).toBe("");
  });

  it("is what the registry resolves to with no protocol/accept", () => {
    const adapter = selectAdapter(undefined, undefined);
    for (const event of sequence) {
      expect(adapter.serialize(event)).toBe(sseAdapter.serialize(event));
    }
    expect(adapter.finalize()).toBe(sseAdapter.finalize());
  });
});

describe("AG-UI adapter", () => {
  it("maps slots to tagged AG-UI events within one run", () => {
    const events = dataPayloads(createAgUiAdapter()) as Array<
      Record<string, unknown>
    >;
    expect(events[0]).toEqual({
      type: "RUN_STARTED",
      threadId: "c1",
      runId: "m1",
    });
    expect(events).toContainEqual({
      type: "TEXT_MESSAGE_START",
      messageId: "m1:A",
      role: "assistant",
      slot: "A",
    });
    expect(events).toContainEqual({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1:B",
      delta: "Yo",
      slot: "B",
    });
    expect(events).toContainEqual({
      type: "CUSTOM",
      name: "slot_error",
      value: { slot: "B", message: "boom" },
    });
    // Conformant runtimes drop CUSTOM, so the failure is also visible text on
    // the failed slot's own message rather than a silently blank column.
    expect(
      events.find(
        (event) =>
          event.type === "TEXT_MESSAGE_CONTENT" &&
          typeof event.delta === "string" &&
          event.delta.includes(SLOT_ERROR_MARKER),
      ),
    ).toMatchObject({ messageId: "m1:B", slot: "B" });
    expect(events).toContainEqual({
      type: "TEXT_MESSAGE_END",
      messageId: "m1:A",
      slot: "A",
    });
    expect(events.at(-1)).toEqual({
      type: "RUN_FINISHED",
      threadId: "c1",
      runId: "m1",
    });
  });

  it("carries the vote token in a CUSTOM arena_matchup event at run start", () => {
    const events = dataPayloads(createAgUiAdapter()) as Array<
      Record<string, unknown>
    >;
    expect(events[1]).toEqual({
      type: "CUSTOM",
      name: "arena_matchup",
      value: {
        matchupId: "m1",
        matchupToken: "tok-secret",
        slots: ["A", "B"],
        mode: "matchup",
        votable: true,
        conversationId: "c1",
        turnIndex: 0,
      },
    });
  });

  it("omits the identifiers a single (non-votable) round has no use for", () => {
    const events = frameEvents(
      createAgUiAdapter().serialize({
        type: "matchup_started",
        matchupId: "m2",
        slots: ["A"],
        mode: "single",
        votable: false,
      }),
    );
    expect(
      events.find((event) => event.name === "arena_matchup")?.value,
    ).toEqual({
      matchupId: "m2",
      slots: ["A"],
      mode: "single",
      votable: false,
    });
    // AG-UI still needs a thread, and the run's own id is the honest stand-in
    // for a round that persisted no conversation.
    expect(events[0]).toEqual({
      type: "RUN_STARTED",
      threadId: "m2",
      runId: "m2",
    });
  });

  it("ends a failed run with RUN_ERROR so a client stops waiting", () => {
    const events = frameEvents(
      createAgUiAdapter().serialize({
        type: "run_error",
        code: "conversation_not_ready",
        message: "Vote for a winning response before continuing",
      }),
    );
    expect(events).toEqual([
      {
        type: "RUN_ERROR",
        code: "conversation_not_ready",
        message: "Vote for a winning response before continuing",
      },
    ]);
  });
});

describe("A2UI adapter", () => {
  it("emits schema-valid NDJSON surfaces per slot", () => {
    const adapter = createA2uiAdapter();
    expect(adapter.headers["content-type"]).toContain("application/x-ndjson");
    const messages = ndjsonMessages(adapter) as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      v: "a2ui/1",
      kind: "surface_init",
      matchupId: "m1",
      // surface_init carries the vote token so the A2UI path is self-contained.
      matchupToken: "tok-secret",
      conversationId: "c1",
      turnIndex: 0,
      surfaces: ["A", "B"],
      mode: "matchup",
      votable: true,
    });
    expect(messages).toContainEqual({
      v: "a2ui/1",
      kind: "text_append",
      surface: "A",
      text: "He",
    });
    expect(messages).toContainEqual({
      v: "a2ui/1",
      kind: "error",
      surface: "B",
      message: "boom",
    });
    expect(messages.at(-1)).toEqual({ v: "a2ui/1", kind: "session_done" });
  });

  it("omits the identifiers a single (non-votable) round has no use for", () => {
    const line = createA2uiAdapter().serialize({
      type: "matchup_started",
      matchupId: "m2",
      slots: ["A"],
      mode: "single",
      votable: false,
    });
    expect(JSON.parse(line)).toEqual({
      v: "a2ui/1",
      kind: "surface_init",
      matchupId: "m2",
      surfaces: ["A"],
      mode: "single",
      votable: false,
    });
  });

  it("closes a failed session with session_error", () => {
    const line = createA2uiAdapter().serialize({
      type: "run_error",
      code: "stream_failed",
      message: "provider exploded",
    });
    expect(JSON.parse(line)).toEqual({
      v: "a2ui/1",
      kind: "session_error",
      code: "stream_failed",
      message: "provider exploded",
    });
  });
});

describe("Vercel AI SDK adapter", () => {
  it("streams slot A as text and slot B as data parts, ending with [DONE]", () => {
    const adapter = createVercelAiAdapter();
    expect(adapter.headers["x-vercel-ai-ui-message-stream"]).toBe("v1");
    const parts = dataPayloads(adapter) as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: "start" });
    // The arena meta carries the vote token so an AI SDK client can vote.
    const meta = parts.find((part) => part.type === "data-arena-meta") as
      | { data?: Record<string, unknown> }
      | undefined;
    expect(meta?.data).toMatchObject({
      matchupId: "m1",
      matchupToken: "tok-secret",
      mode: "matchup",
      votable: true,
    });
    expect(parts).toContainEqual({ type: "text-start", id: "m1" });
    expect(parts).toContainEqual({
      type: "text-delta",
      id: "m1",
      delta: "He",
    });
    expect(parts).toContainEqual({
      type: "data-arena-b-delta",
      data: { text: "Yo" },
    });
    expect(parts).toContainEqual({ type: "text-end", id: "m1" });
    expect(parts).toContainEqual({ type: "data-arena-b-done", data: {} });
    expect(parts.at(-1)).toEqual({ type: "finish" });
    expect(adapter.finalize()).toBe("data: [DONE]\n\n");
  });

  it("omits the identifiers a single (non-votable) round has no use for", () => {
    const parts = frameEvents(
      createVercelAiAdapter().serialize({
        type: "matchup_started",
        matchupId: "m2",
        slots: ["A"],
        mode: "single",
        votable: false,
      }),
    );
    expect(
      parts.find((part) => part.type === "data-arena-meta")?.data,
    ).toEqual({
      matchupId: "m2",
      mainSlot: "A",
      dataSlot: "B",
      mode: "single",
      votable: false,
    });
  });

  it("reports a terminal failure as the protocol's own error part", () => {
    const parts = frameEvents(
      createVercelAiAdapter().serialize({
        type: "run_error",
        code: "stream_failed",
        message: "provider exploded",
      }),
    );
    expect(parts).toEqual([
      { type: "error", errorText: "stream_failed: provider exploded" },
    ]);
  });
});

describe("OpenAI SSE adapter", () => {
  /** What Open WebUI and every other positional client actually reads. */
  const readPositionally = (chunks: OpenAiChunk[]): string =>
    chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("");

  it("gives a positional choices[0] reader slot A alone, coherently", () => {
    const chunks = dataPayloads(createOpenAiSseAdapter()) as OpenAiChunk[];
    // The regression: one choice per frame tagged by `index` spliced both
    // models into one message for anything reading `choices[0]` by position.
    expect(readPositionally(chunks)).toBe("Hello");
    expect(
      chunks.every((chunk) => chunk.choices[0]?.index === 0),
    ).toBe(true);
  });

  it("carries slot B as choices[1] of the same frame", () => {
    const chunks = dataPayloads(createOpenAiSseAdapter()) as OpenAiChunk[];
    expect(chunks.every((chunk) => chunk.object === "chat.completion.chunk")).toBe(
      true,
    );
    const tokenB = chunks.find(
      (chunk) => chunk.choices[1]?.delta.content === "Yo",
    );
    expect(tokenB?.choices[1]?.index).toBe(1);
    // Slot A says nothing in that frame, and has not finished either.
    expect(tokenB?.choices[0]).toEqual({
      index: 0,
      delta: {},
      finish_reason: null,
    });
    const slotBFinish = chunks
      .map((chunk) => chunk.choices[1]?.finish_reason)
      .filter((reason) => reason !== undefined);
    expect(slotBFinish.at(-1)).toBe("stop");
    expect(createOpenAiSseAdapter().finalize()).toBe("data: [DONE]\n\n");
  });

  it("attaches the matchup metadata to the first chunk only, conversation included", () => {
    const chunks = dataPayloads(createOpenAiSseAdapter()) as OpenAiChunk[];
    // conversationId/turnIndex used to be dropped here, which made multi-turn
    // continuation impossible over the protocol with the widest client base.
    expect(chunks[0]?.omni_arena).toEqual({
      matchupId: "m1",
      matchupToken: "tok-secret",
      conversationId: "c1",
      turnIndex: 0,
      mode: "matchup",
      votable: true,
    });
    // Every later chunk stays a plain OpenAI chunk for strict clients.
    expect(
      chunks.slice(1).every((chunk) => chunk.omni_arena === undefined),
    ).toBe(true);
  });

  it("marks a failed slot instead of passing the message off as content", () => {
    const chunks = dataPayloads(createOpenAiSseAdapter()) as OpenAiChunk[];
    const failure = chunks.find((chunk) => chunk.omni_arena_error);
    expect(failure?.omni_arena_error).toEqual({ slot: "B", message: "boom" });
    expect(failure?.choices[1]?.delta.content).toContain(SLOT_ERROR_MARKER);
  });

  it("omits the identifiers a single round has no use for", () => {
    const frame = createOpenAiSseAdapter().serialize({
      type: "matchup_started",
      matchupId: "m2",
      slots: ["A"],
      mode: "single",
      votable: false,
    });
    const chunk = JSON.parse(frame.slice("data: ".length)) as OpenAiChunk;
    expect(chunk.omni_arena).toEqual({
      matchupId: "m2",
      mode: "single",
      votable: false,
    });
    // One slot, so the only choice is slot A at position 0.
    expect(chunk.choices).toHaveLength(1);
  });

  it("reports a terminal failure as an OpenAI error frame", () => {
    const frame = createOpenAiSseAdapter().serialize({
      type: "run_error",
      code: "conversation_not_ready",
      message: "Vote first",
    });
    expect(JSON.parse(frame.slice("data: ".length))).toEqual({
      error: {
        message: "Vote first",
        type: "omni_arena_error",
        code: "conversation_not_ready",
      },
    });
  });
});

describe("selectAdapter", () => {
  it("selects by protocol query param", () => {
    expect(selectAdapter("agui", undefined).serialize(started)).toContain(
      "RUN_STARTED",
    );
    expect(
      selectAdapter("openai", undefined).serialize({
        type: "token",
        slot: "A",
        token: "x",
      }),
    ).toContain("chat.completion.chunk");
  });

  it("falls back to the Accept header when no param is given", () => {
    const adapter = selectAdapter(undefined, "application/vnd.a2ui+json");
    expect(adapter.headers["content-type"]).toContain("application/x-ndjson");
  });

  it("lets the query param win over the Accept header", () => {
    const adapter = selectAdapter("sse", "application/vnd.a2ui+json");
    expect(adapter.serialize({ type: "token", slot: "A", token: "x" })).toBe(
      sseAdapter.serialize({ type: "token", slot: "A", token: "x" }),
    );
  });

  it("falls back to native SSE for an unknown protocol", () => {
    const adapter = selectAdapter("nope", undefined);
    expect(adapter.serialize({ type: "token", slot: "A", token: "x" })).toBe(
      sseAdapter.serialize({ type: "token", slot: "A", token: "x" }),
    );
  });
});

/** The body a stock `HttpAgent`/`useAGUIRuntime` posts, verbatim. */
const runAgentInput = {
  threadId: "t1",
  runId: "r1",
  state: {},
  messages: [{ id: "m1", role: "user", content: "hello" }],
  tools: [],
  context: [],
  forwardedProps: {},
};

/** The body an OpenAI-compatible client posts, extra knobs and all. */
const chatCompletionRequest = {
  model: "omni-arena",
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "hello" },
  ],
  stream: true,
  temperature: 0.7,
  max_tokens: 512,
  user: "anon_openai",
};

function parseFor(protocol: string, body: unknown) {
  return parseChatRequest(body, selectProtocol(protocol, undefined).request);
}

describe("request envelopes (ingress)", () => {
  it("accepts OmniArena's own body on every protocol, unchanged", () => {
    for (const protocol of ["sse", "ag-ui", "a2ui", "vercel", "openai"]) {
      expect(
        parseFor(protocol, {
          prompt: "hello",
          sessionId: "anon_x",
          arena: true,
        }),
      ).toEqual({
        ok: true,
        request: { prompt: "hello", sessionId: "anon_x", arena: true },
      });
    }
  });

  it("keeps a body carrying both shapes on the OmniArena path", () => {
    // A transport that sends `prompt` *and* a transcript predates this change;
    // reinterpreting it as a protocol envelope would silently move the round's
    // prompt to a different message.
    const parsed = parseFor("ag-ui", {
      ...runAgentInput,
      prompt: "the real prompt",
    });
    expect(parsed).toMatchObject({ request: { prompt: "the real prompt" } });
  });

  it("translates a canonical AG-UI RunAgentInput", () => {
    expect(parseFor("ag-ui", runAgentInput)).toEqual({
      ok: true,
      request: { prompt: "hello" },
    });
  });

  it("reads session, conversation and arena opt-in from forwardedProps", () => {
    expect(
      parseFor("ag-ui", {
        ...runAgentInput,
        forwardedProps: {
          sessionId: "anon_agui",
          conversationId: "00000000-0000-4000-8000-000000000009",
          arena: true,
        },
      }),
    ).toEqual({
      ok: true,
      request: {
        prompt: "hello",
        sessionId: "anon_agui",
        conversationId: "00000000-0000-4000-8000-000000000009",
        arena: true,
      },
    });
  });

  it("never reads a client-minted threadId as a conversation id", () => {
    // Clients mint their own thread ids (assistant-ui mints a UUID); treating
    // one as an arena conversation would 404 every stock client's first turn.
    const parsed = parseFor("ag-ui", {
      ...runAgentInput,
      threadId: "00000000-0000-4000-8000-0000000000aa",
    });
    expect(parsed).toEqual({ ok: true, request: { prompt: "hello" } });
  });

  it("takes the newest user message and joins its text parts", () => {
    expect(
      parseFor("ag-ui", {
        ...runAgentInput,
        messages: [
          { id: "m1", role: "user", content: "stale" },
          { id: "m2", role: "assistant", content: "an earlier answer" },
          {
            id: "m3",
            role: "user",
            content: [
              { type: "text", text: "look at " },
              { type: "image", image: "https://example.test/x.png" },
              { type: "text", text: "this" },
            ],
          },
        ],
      }),
    ).toMatchObject({ request: { prompt: "look at this" } });
  });

  it("fails loudly when a claimed envelope carries nothing to answer", () => {
    expect(
      parseFor("ag-ui", { ...runAgentInput, messages: [] }),
    ).toMatchObject({ ok: false, fieldErrors: { messages: [expect.any(String)] } });
    expect(
      parseFor("openai", {
        ...chatCompletionRequest,
        messages: [{ role: "assistant", content: "only mine" }],
      }),
    ).toMatchObject({ ok: false });
  });

  it("fails loudly on a malformed arena field rather than dropping it", () => {
    expect(
      parseFor("ag-ui", {
        ...runAgentInput,
        forwardedProps: { conversationId: "not-a-uuid" },
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { forwardedProps: [expect.any(String)] },
    });
  });

  it("translates a standard /chat/completions body, ignoring its knobs", () => {
    expect(parseFor("openai", chatCompletionRequest)).toEqual({
      ok: true,
      // `user` is OpenAI's end-user identifier, the nearest thing the protocol
      // has to the arena's anonymous session.
      request: { prompt: "hello", sessionId: "anon_openai" },
    });
  });

  it("reads the arena's own OpenAI inputs from the omni_arena extension", () => {
    expect(
      parseFor("openai", {
        ...chatCompletionRequest,
        omni_arena: {
          sessionId: "anon_extension",
          conversationId: "00000000-0000-4000-8000-000000000009",
          arena: true,
        },
      }),
    ).toMatchObject({
      request: {
        sessionId: "anon_extension",
        conversationId: "00000000-0000-4000-8000-000000000009",
        arena: true,
      },
    });
  });

  it("refuses a non-streaming completion instead of streaming anyway", () => {
    expect(
      parseFor("openai", { ...chatCompletionRequest, stream: false }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { stream: [expect.any(String)] },
    });
  });

  it("translates a useChat body in both AI SDK message shapes", () => {
    // v5 UIMessages put text in `parts`; v4 used `content`.
    expect(
      parseFor("vercel", {
        id: "chat-1",
        trigger: "submit-message",
        messages: [
          {
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
        sessionId: "anon_vercel",
      }),
    ).toEqual({
      ok: true,
      request: { prompt: "hello", sessionId: "anon_vercel" },
    });
    expect(
      parseFor("vercel", {
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toEqual({ ok: true, request: { prompt: "hello" } });
  });

  it("leaves protocols without a native envelope on the OmniArena body", () => {
    // Native SSE and A2UI have no canonical client request to be compatible
    // with, so a transcript-shaped body is rejected rather than guessed at.
    for (const protocol of ["sse", "a2ui"]) {
      expect(selectProtocol(protocol, undefined).request).toBeUndefined();
      expect(parseFor(protocol, runAgentInput)).toMatchObject({ ok: false });
    }
  });
});
