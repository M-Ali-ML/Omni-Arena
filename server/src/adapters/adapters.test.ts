import { describe, expect, it } from "vitest";
import type { PublicArenaEvent } from "../core/events.js";
import { createA2uiAdapter } from "./a2ui.js";
import { createAgUiAdapter } from "./ag-ui.js";
import type { EventAdapter } from "./event-adapter.js";
import { createOpenAiSseAdapter } from "./openai-sse.js";
import { selectAdapter } from "./registry.js";
import { sseAdapter } from "./sse.js";
import { createVercelAiAdapter } from "./vercel-ai.js";

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
      conversationId: "c1",
      turnIndex: 0,
      surfaces: ["A", "B"],
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
});

describe("OpenAI SSE adapter", () => {
  it("maps slots onto dual chat.completion.chunk choices", () => {
    const adapter = createOpenAiSseAdapter();
    const chunks = dataPayloads(adapter) as Array<{
      object: string;
      choices: Array<{
        index: number;
        delta: { role?: string; content?: string };
        finish_reason: string | null;
      }>;
    }>;
    expect(chunks.every((chunk) => chunk.object === "chat.completion.chunk")).toBe(
      true,
    );
    const tokenA = chunks.find((chunk) => chunk.choices[0]?.delta.content === "He");
    expect(tokenA?.choices[0]?.index).toBe(0);
    const tokenB = chunks.find((chunk) => chunk.choices[0]?.delta.content === "Yo");
    expect(tokenB?.choices[0]?.index).toBe(1);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        choices: [expect.objectContaining({ index: 1, finish_reason: "stop" })],
      }),
    );
    expect(adapter.finalize()).toBe("data: [DONE]\n\n");
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
