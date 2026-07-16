import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useArenaChat } from "./useArenaChat.js";

// Node 24 ships an experimental global localStorage getter that shadows
// jsdom's and resolves to undefined, so provide an in-memory stand-in.
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

type SseEvent = Record<string, unknown> & { type: string };

function sseBody(events: SseEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
}

function mockChatFetch(events: SseEvent[]): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(sseBody(events), { status: 200 }));
}

const streamedMatchup: SseEvent[] = [
  {
    type: "matchup_started",
    matchupId: "m1",
    matchupToken: "t1",
    conversationId: "c1",
    turnIndex: 0,
  },
  { type: "token", slot: "A", token: "Hello" },
  { type: "token", slot: "B", token: "Hi" },
  { type: "token", slot: "A", token: " there" },
  { type: "slot_done", slot: "A" },
  { type: "slot_done", slot: "B" },
  { type: "matchup_done" },
];

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useArenaChat", () => {
  it("accumulates multiplexed SSE tokens into the right slots", async () => {
    vi.stubGlobal("fetch", mockChatFetch(streamedMatchup));
    const { result } = renderHook(() => useArenaChat());

    await act(() => result.current.sendPrompt("Compare"));

    expect(result.current.slots.A.content).toBe("Hello there");
    expect(result.current.slots.B.content).toBe("Hi");
    expect(result.current.slots.A.status).toBe("done");
    expect(result.current.slots.B.status).toBe("done");
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.canVote).toBe(true);
    expect(result.current.revealedModels).toBeUndefined();
  });

  it("marks a slot as failed without touching the other one", async () => {
    vi.stubGlobal(
      "fetch",
      mockChatFetch([
        {
          type: "matchup_started",
          matchupId: "m1",
          matchupToken: "t1",
          conversationId: "c1",
          turnIndex: 0,
        },
        { type: "token", slot: "A", token: "Fine" },
        { type: "slot_error", slot: "B", message: "Provider exploded" },
        { type: "slot_done", slot: "A" },
        { type: "slot_done", slot: "B" },
        { type: "matchup_done" },
      ]),
    );
    const { result } = renderHook(() => useArenaChat());

    await act(() => result.current.sendPrompt("Compare"));

    expect(result.current.slots.A.status).toBe("done");
    expect(result.current.slots.B.status).toBe("error");
    expect(result.current.slots.B.error).toBe("Provider exploded");
  });

  it("sends the matchup token on vote and reveals identities", async () => {
    const revealed = {
      A: { id: "model_1", displayName: "Alpha" },
      B: { id: "model_2", displayName: "Beta" },
    };
    const fetchMock = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        void init;
        if (String(url).endsWith("/chat")) {
          return new Response(sseBody(streamedMatchup), { status: 200 });
        }
        return Response.json({ accepted: true, models: revealed });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useArenaChat());

    await act(() => result.current.sendPrompt("Compare"));
    await act(() => result.current.vote("left"));

    const voteCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/vote"),
    );
    expect(voteCall).toBeDefined();
    expect(JSON.parse(String(voteCall?.[1]?.body))).toEqual({
      matchupId: "m1",
      matchupToken: "t1",
      vote: "left",
    });
    await waitFor(() => {
      expect(result.current.revealedModels).toEqual(revealed);
    });
    expect(result.current.canVote).toBe(false);
  });

  it("continues decisive votes in the same conversation", async () => {
    const followUpEvents: SseEvent[] = [
      {
        type: "matchup_started",
        matchupId: "m2",
        matchupToken: "t2",
        conversationId: "c1",
        turnIndex: 1,
      },
      { type: "matchup_done" },
    ];
    let chatCalls = 0;
    const fetchMock = vi.fn(
      async (url: RequestInfo | URL, _init?: RequestInit) => {
        if (String(url).endsWith("/vote")) {
          return Response.json({
            accepted: true,
            models: {
              A: { id: "model_1", displayName: "Alpha" },
              B: { id: "model_2", displayName: "Beta" },
            },
          });
        }
        chatCalls += 1;
        return new Response(
          sseBody(chatCalls === 1 ? streamedMatchup : followUpEvents),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useArenaChat());

    await act(() => result.current.sendPrompt("First"));
    await act(() => result.current.vote("left"));
    await act(() => result.current.sendPrompt("Second"));

    const chatRequests = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/chat"),
    );
    const secondRequest = chatRequests[1]?.[1];
    if (!secondRequest) {
      throw new Error("Missing follow-up request");
    }
    expect(JSON.parse(String(secondRequest.body))).toMatchObject({
      prompt: "Second",
      conversationId: "c1",
    });
    expect(result.current.conversationId).toBe("c1");
  });

  it("surfaces vote rejection as an error without revealing models", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/chat")) {
        return new Response(sseBody(streamedMatchup), { status: 200 });
      }
      return Response.json({ error: "Vote already recorded" }, { status: 409 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useArenaChat());

    await act(() => result.current.sendPrompt("Compare"));
    let thrown: unknown;
    await act(async () => {
      thrown = await result.current.vote("left").catch((error) => error);
    });

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Vote already recorded");
    expect(result.current.revealedModels).toBeUndefined();
    expect(result.current.error).toBe("Vote already recorded");
  });
});
