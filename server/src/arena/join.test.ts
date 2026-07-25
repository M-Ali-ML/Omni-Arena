import { describe, expect, it } from "vitest";
import type { ArenaEvent, ArenaSlot } from "../core/events.js";
import {
  DEFAULT_JOIN_MAX_PENDING,
  DEFAULT_JOIN_MAX_QUEUED_EVENTS,
  DEFAULT_JOIN_WINDOW_MS,
  JoinBroker,
  JoinedRound,
  JoinFailureError,
  asJoinFailure,
  parseJoinConfig,
  type JoinConfig,
  type JoinScope,
} from "./join.js";

const config = (overrides: Partial<JoinConfig> = {}): JoinConfig => ({
  windowMs: 25,
  maxPending: 8,
  maxQueuedEvents: 64,
  ...overrides,
});

const scope: JoinScope = {
  joinKey: "chat-7f3a",
  sessionId: "anon_owner",
  conversationId: null,
  prompt: "Compare these two",
};

/** A stable secret so scope keys are comparable across broker instances. */
const secret = "join-test-secret";

function slotDone(slot: ArenaSlot, content: string): ArenaEvent {
  return {
    type: "slot_done",
    slot,
    content,
    latencyMs: 1,
    ttftMs: 1,
    streamDurationMs: 1,
    outputTokenCount: 1,
    tokenCountSource: "estimated",
    markdownDensity: 0,
    modelVersion: null,
    error: null,
  };
}

async function collect(
  events: AsyncIterable<ArenaEvent>,
): Promise<ArenaEvent[]> {
  const seen: ArenaEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
}

describe("join config", () => {
  it("defaults to the reference bridge's window and is disabled by zero", () => {
    expect(parseJoinConfig({})).toEqual({
      windowMs: DEFAULT_JOIN_WINDOW_MS,
      maxPending: DEFAULT_JOIN_MAX_PENDING,
      maxQueuedEvents: DEFAULT_JOIN_MAX_QUEUED_EVENTS,
    });
    expect(new JoinBroker(parseJoinConfig({})).enabled).toBe(true);
    expect(
      new JoinBroker(parseJoinConfig({ ARENA_JOIN_WINDOW_MS: "0" })).enabled,
    ).toBe(false);
  });

  it("takes the per-connection backlog from the environment", () => {
    expect(
      parseJoinConfig({ ARENA_JOIN_MAX_QUEUED_EVENTS: "512" }),
    ).toMatchObject({ maxQueuedEvents: 512 });
    // The value the broker hands to every JoinedRound it backs, so a configured
    // backlog actually reaches the slot channels.
    expect(
      new JoinBroker(parseJoinConfig({ ARENA_JOIN_MAX_QUEUED_EVENTS: "512" }))
        .maxQueuedEvents,
    ).toBe(512);
  });

  it.each([
    ["not a number", "plenty"],
    ["below the floor", "15"],
    ["above the ceiling", "1000001"],
    ["fractional", "64.5"],
  ])(
    "refuses a backlog that is %s, before the server listens",
    (_label, value: string) => {
      expect(() =>
        parseJoinConfig({ ARENA_JOIN_MAX_QUEUED_EVENTS: value }),
      ).toThrow();
    },
  );
});

describe("join scoping", () => {
  it("pairs two claims that agree on the whole scope", () => {
    const broker = new JoinBroker(config(), secret);

    expect(broker.claim(scope)).toMatchObject({ kind: "leader", slot: "A" });
    expect(broker.claim({ ...scope })).toMatchObject({
      kind: "follower",
      slot: "B",
    });
  });

  it.each([
    ["a different session", { sessionId: "anon_attacker" }],
    ["a different prompt", { prompt: "Compare these two " + "\u200b" }],
    [
      "a different conversation",
      { conversationId: "9c6a1d2f-0000-4000-8000-0000000000aa" },
    ],
    ["a guessed join key", { joinKey: "chat-7f3b" }],
  ])(
    "refuses to attach %s to an open matchup",
    (_label, override: Partial<JoinScope>) => {
      const broker = new JoinBroker(config(), secret);
      broker.claim(scope);

      // Not "follower": the intruder gets its own matchup and can never read a
      // byte of the victim's stream. Guessing the join key is not enough,
      // because the key alone is not the capability — the whole scope is.
      expect(broker.claim({ ...scope, ...override })).toMatchObject({
        kind: "leader",
      });
    },
  );

  it("never derives the same scope key across processes", () => {
    // Two brokers with no configured secret must not agree, so a scope key
    // observed anywhere (a log, a heap dump) cannot be replayed against a
    // restarted or sibling process.
    expect(new JoinBroker(config()).scopeKey(scope)).not.toBe(
      new JoinBroker(config()).scopeKey(scope),
    );
    expect(new JoinBroker(config(), secret).scopeKey(scope)).toBe(
      new JoinBroker(config(), secret).scopeKey(scope),
    );
  });

  it("does not leak the prompt or the join key into the scope key", () => {
    const key = new JoinBroker(config(), secret).scopeKey(scope);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    for (const part of Object.values(scope)) {
      expect(key).not.toContain(String(part));
    }
  });
});

describe("join pairing", () => {
  it("elects exactly one leader when both siblings arrive simultaneously", () => {
    const broker = new JoinBroker(config(), secret);

    // `claim` is synchronous end to end, so two claims dispatched in the same
    // tick cannot interleave and cannot both win, in either order.
    const claims = [broker.claim(scope), broker.claim(scope)];

    expect(claims.filter((claim) => claim.kind === "leader")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "follower")).toHaveLength(1);
    expect(broker.pendingCount).toBe(1);
  });

  it("releases the leader as soon as its sibling lands", async () => {
    const broker = new JoinBroker(config({ windowMs: 10_000 }), secret);
    const leader = broker.claim(scope);
    if (leader.kind !== "leader") {
      throw new Error("expected a leader");
    }

    broker.claim(scope);

    await expect(leader.session.sibling()).resolves.toBe(true);
  });

  it("refuses a third claim on a scope whose slots are taken", () => {
    const broker = new JoinBroker(config(), secret);
    broker.claim(scope);
    broker.claim(scope);

    // A matchup is a pair. Silently starting a second one is the very failure
    // this primitive exists to prevent, so an N-way compare view must use one
    // join key per pair.
    expect(broker.claim(scope)).toEqual({ kind: "exhausted" });
  });

  it("closes the window with no sibling and rejects a late one", async () => {
    const broker = new JoinBroker(config({ windowMs: 5 }), secret);
    const leader = broker.claim(scope);
    if (leader.kind !== "leader") {
      throw new Error("expected a leader");
    }

    await expect(leader.session.sibling()).resolves.toBe(false);
    expect(broker.claim(scope)).toEqual({ kind: "expired" });
  });

  it("bounds the pending set and refuses joins beyond it", () => {
    const broker = new JoinBroker(config({ maxPending: 2 }), secret);
    broker.claim({ ...scope, joinKey: "one" });
    broker.claim({ ...scope, joinKey: "two" });

    expect(broker.claim({ ...scope, joinKey: "three" })).toEqual({
      kind: "unavailable",
    });
    expect(broker.pendingCount).toBe(2);
    // An unpaired scope already at the cap still pairs, so a flood degrades new
    // joins rather than breaking the ones in flight.
    expect(broker.claim({ ...scope, joinKey: "two" })).toMatchObject({
      kind: "follower",
    });
  });

  it("sweeps settled scopes once their grace period passes", () => {
    const broker = new JoinBroker(config({ windowMs: 5 }), secret);
    broker.claim(scope, 0);
    broker.claim(scope, 0);
    expect(broker.pendingCount).toBe(1);

    broker.claim({ ...scope, joinKey: "later" }, 60_000);

    expect(broker.pendingCount).toBe(1);
  });

  it("hands the leader's pre-stream failure to the sibling", async () => {
    const broker = new JoinBroker(config(), secret);
    const leader = broker.claim(scope);
    const follower = broker.claim(scope);
    if (leader.kind !== "leader" || follower.kind !== "follower") {
      throw new Error("expected a pair");
    }

    leader.session.fail({
      status: 409,
      code: "conversation_not_ready",
      message: "Vote first",
    });

    await expect(follower.session.accept()).rejects.toBeInstanceOf(
      JoinFailureError,
    );
    await follower.session.accept().catch((error: unknown) => {
      expect(asJoinFailure(error)).toEqual({
        status: 409,
        code: "conversation_not_ready",
        message: "Vote first",
      });
    });
  });
});

describe("joined round", () => {
  const source = (): AsyncIterable<ArenaEvent> =>
    (async function* () {
      yield { type: "token", slot: "A", token: "a1" } as ArenaEvent;
      yield { type: "token", slot: "B", token: "b1" } as ArenaEvent;
      yield slotDone("B", "b1");
      yield { type: "token", slot: "A", token: "a2" } as ArenaEvent;
      yield slotDone("A", "a1a2");
      yield { type: "matchup_done" } as ArenaEvent;
    })();

  it("gives each slot only its own events, terminated on its own completion", async () => {
    const persisted: ArenaEvent[] = [];
    const round = new JoinedRound(source, async (event) => {
      persisted.push(event);
    });
    round.start();

    const [a, b] = await Promise.all([
      collect(round.slot("A")),
      collect(round.slot("B")),
    ]);

    expect(a).toEqual([
      { type: "token", slot: "A", token: "a1" },
      { type: "token", slot: "A", token: "a2" },
      slotDone("A", "a1a2"),
      { type: "matchup_done" },
    ]);
    expect(b).toEqual([
      { type: "token", slot: "B", token: "b1" },
      slotDone("B", "b1"),
      { type: "matchup_done" },
    ]);
    // Persistence happens once, on the leader's pump, for both slots.
    expect(persisted.filter((event) => event.type === "slot_done")).toHaveLength(
      2,
    );
  });

  it("completes and persists slot B after its consumer walks away", async () => {
    const persisted: ArenaEvent[] = [];
    const round = new JoinedRound(source, async (event) => {
      persisted.push(event);
    });
    const abandoned = new AbortController();
    abandoned.abort();
    round.start();

    const [a, b] = await Promise.all([
      collect(round.slot("A")),
      collect(round.slot("B", abandoned.signal)),
    ]);

    expect(b).toEqual([]);
    expect(a.at(-1)).toEqual({ type: "matchup_done" });
    expect(
      persisted.filter((event) => event.type === "slot_done").map((e) => e.slot),
    ).toEqual(["B", "A"]);
  });

  it("surfaces a mid-stream failure on every attached slot", async () => {
    const round = new JoinedRound(
      () =>
        (async function* () {
          yield { type: "token", slot: "A", token: "a1" } as ArenaEvent;
          throw new Error("provider exploded");
        })(),
      async () => {},
    );
    round.start();

    await expect(collect(round.slot("A"))).rejects.toThrow(
      "provider exploded",
    );
    await expect(collect(round.slot("B"))).rejects.toThrow(
      "provider exploded",
    );
  });

  it("stops both slots when the matchup is stopped", async () => {
    const controller = new AbortController();
    const round = new JoinedRound(
      (signal) =>
        (async function* () {
          yield { type: "token", slot: "A", token: "a1" } as ArenaEvent;
          while (!signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        })(),
      async () => {},
    );
    round.start(controller.signal);

    const drained = Promise.all([
      collect(round.slot("A")),
      collect(round.slot("B")),
    ]);
    controller.abort();

    const [a, b] = await drained;
    expect(a).toEqual([{ type: "token", slot: "A", token: "a1" }]);
    expect(b).toEqual([]);
  });

  it("fails a slot whose consumer falls too far behind instead of growing", async () => {
    const round = new JoinedRound(
      () =>
        (async function* () {
          for (let index = 0; index < 10; index += 1) {
            yield { type: "token", slot: "A", token: `a${index}` } as ArenaEvent;
          }
          yield slotDone("A", "a");
        })(),
      async () => {},
      4,
    );
    round.start();
    // Let the pump run to completion with nobody draining slot A.
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(collect(round.slot("A"))).rejects.toThrow(
      /fell too far behind/,
    );
  });
});
