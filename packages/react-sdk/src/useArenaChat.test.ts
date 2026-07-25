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

/** An SSE body that stays open, so a matchup can be cancelled mid-stream. */
function openEndedChatFetch(events: SseEvent[]): ReturnType<typeof vi.fn> {
  const encoder = new TextEncoder();
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
        // Like real fetch, aborting the request errors the body stream.
        init?.signal?.addEventListener("abort", () =>
          controller.error(new DOMException("Aborted", "AbortError")),
        );
      },
    });
    return new Response(body, { status: 200 });
  });
}

/**
 * Minimal WebSocket stand-in: jsdom's implementation would try to dial a real
 * server. Connects on a microtask so `stop()` exercises its wait-for-open path.
 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState: number = FakeSocket.CONNECTING;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.settle());
  }

  /** Overridden by the never-connects variant used below. */
  protected settle(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open", {});
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", {});
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
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
  FakeSocket.instances = [];
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

  it("starts fresh after a round that carried no conversation id", async () => {
    const singleRound: SseEvent[] = [
      {
        type: "matchup_started",
        matchupId: "s1",
        slots: ["A"],
        mode: "single",
        votable: false,
      },
      { type: "token", slot: "A", token: "One answer" },
      { type: "slot_done", slot: "A" },
      { type: "matchup_done" },
    ];
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(sseBody(singleRound), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useArenaChat());

    await act(() => result.current.sendPrompt("First"));
    await act(() => result.current.sendPrompt("Second"));

    expect(result.current.slots.A.content).toBe("One answer");
    expect(result.current.canVote).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.conversationId).toBeUndefined();
    // Nothing was persisted to continue from, so the follow-up must not send
    // back an id the server would answer 404 for.
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).not.toHaveProperty("conversationId");
  });

  it("settles the view when the server reports a terminal run error", async () => {
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
        { type: "token", slot: "A", token: "Half an" },
        {
          type: "run_error",
          code: "stream_failed",
          message: "database is on fire",
        },
      ]),
    );
    const { result } = renderHook(() => useArenaChat());

    await act(() => result.current.sendPrompt("Compare"));

    expect(result.current.error).toBe("database is on fire");
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.canVote).toBe(false);
    expect(result.current.slots.A.content).toBe("Half an");
    expect(result.current.slots.A.status).toBe("done");
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

  it("stops an in-flight matchup over the control socket", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal(
      "fetch",
      openEndedChatFetch([
        {
          type: "matchup_started",
          matchupId: "m1",
          matchupToken: "t1",
          conversationId: "c1",
          turnIndex: 0,
        },
        { type: "token", slot: "A", token: "Half an" },
      ]),
    );
    const { result } = renderHook(() => useArenaChat());

    let streaming: Promise<void> = Promise.resolve();
    await act(async () => {
      streaming = result.current.sendPrompt("Compare");
    });
    await waitFor(() => {
      expect(result.current.slots.A.content).toBe("Half an");
    });
    expect(result.current.isStreaming).toBe(true);

    await act(() => result.current.stop());
    await streaming;

    const socket = FakeSocket.instances[0];
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket?.url).toBe("ws://localhost:3000/api/arena/control");
    expect(JSON.parse(socket?.sent[0] ?? "{}")).toEqual({
      type: "stop",
      matchupId: "m1",
    });
    // The server abandons the SSE body without a terminal event, so the hook
    // settles the streaming slot itself and keeps the tokens it received.
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.slots.A.status).toBe("done");
    expect(result.current.slots.A.content).toBe("Half an");
    expect(result.current.canVote).toBe(true);
    expect(result.current.error).toBeNull();

    // The ack means the aborted stream is over, so the channel closes with it.
    expect(socket?.closed).toBe(false);
    act(() => {
      socket?.emit("message", {
        data: JSON.stringify({ type: "stopped", matchupId: "m1", ok: true }),
      });
    });
    expect(socket?.closed).toBe(true);
  });

  it("derives a wss control URL from an absolute baseUrl and closes on unmount", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", mockChatFetch(streamedMatchup));
    const { result, unmount } = renderHook(() =>
      useArenaChat({ baseUrl: "https://arena.example.com" }),
    );

    await act(() => result.current.sendPrompt("Compare"));
    await act(() => result.current.stop());

    const socket = FakeSocket.instances[0];
    expect(socket?.url).toBe("wss://arena.example.com/api/arena/control");
    expect(socket?.closed).toBe(false);

    unmount();
    expect(socket?.closed).toBe(true);
  });

  it("reports a control channel that will not open", async () => {
    class DeadSocket extends FakeSocket {
      protected override settle(): void {
        this.emit("error", {});
      }
    }
    vi.stubGlobal("WebSocket", DeadSocket);
    vi.stubGlobal("fetch", mockChatFetch(streamedMatchup));
    const { result } = renderHook(() => useArenaChat());

    await act(() => result.current.sendPrompt("Compare"));
    await act(() => result.current.stop());

    expect(result.current.error).toBe("Control channel unavailable");
  });

  it("does nothing when there is no matchup to stop", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", mockChatFetch(streamedMatchup));
    const { result } = renderHook(() => useArenaChat());

    await act(() => result.current.stop());

    expect(FakeSocket.instances).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });
});
