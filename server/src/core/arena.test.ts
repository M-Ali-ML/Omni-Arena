import { describe, expect, it } from "vitest";
import { ArenaCore } from "./arena.js";
import type {
  Model,
  ModelProviderPort,
  ProviderResolverPort,
} from "./ports.js";

const model = (id: string): Model => ({
  id,
  displayName: id,
  provider: id,
  providerModelId: id,
  enabled: true,
});

const duel = { A: model("a"), B: model("b") };

class Resolver implements ProviderResolverPort {
  constructor(private readonly providers: Record<string, ModelProviderPort>) {}

  resolve(provider: string): ModelProviderPort {
    const resolved = this.providers[provider];
    if (!resolved) {
      throw new Error("Missing test provider");
    }
    return resolved;
  }
}

describe("ArenaCore", () => {
  it("multiplexes two model streams", async () => {
    const core = new ArenaCore(
      new Resolver({
        a: {
          async *stream() {
            yield { type: "token" as const, token: "A1" };
            await new Promise((resolve) => setTimeout(resolve, 10));
            yield { type: "token" as const, token: "A2" };
          },
        },
        b: {
          async *stream() {
            await new Promise((resolve) => setTimeout(resolve, 2));
            yield { type: "metadata" as const, modelVersion: "b-2026-07" };
            yield { type: "token" as const, token: "B1" };
            yield { type: "metadata" as const, outputTokenCount: 7 };
          },
        },
      }),
    );

    const events = [];
    for await (const event of core.stream(
      [{ role: "user", content: "prompt" }],
      duel,
    )) {
      events.push(event);
    }

    expect(
      events
        .filter((event) => event.type === "token")
        .map((event) => `${event.slot}:${event.token}`),
    ).toEqual(["A:A1", "B:B1", "A:A2"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "slot_done",
        slot: "B",
        modelVersion: "b-2026-07",
        outputTokenCount: 7,
        tokenCountSource: "provider",
      }),
    );
    expect(events.at(-1)).toEqual({ type: "matchup_done" });
  });

  it("streams only slot A when no slot B model is given", async () => {
    let bTouched = false;
    const core = new ArenaCore(
      new Resolver({
        a: {
          async *stream() {
            yield { type: "token" as const, token: "A-only" };
          },
        },
        b: {
          async *stream() {
            bTouched = true;
          },
        },
      }),
    );

    const events = [];
    for await (const event of core.stream(
      [{ role: "user", content: "prompt" }],
      { A: model("a") },
    )) {
      events.push(event);
    }

    expect(bTouched).toBe(false);
    expect(events.some((event) => event.type === "token" && event.slot === "B")).toBe(
      false,
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "token", slot: "A", token: "A-only" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "slot_done", slot: "A" }),
    );
    expect(events.filter((event) => event.type === "slot_done")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "matchup_done" });
  });

  it("keeps one stream alive when the other fails", async () => {
    const core = new ArenaCore(
      new Resolver({
        a: {
          async *stream() {
            throw new Error("A exploded");
          },
        },
        b: {
          async *stream() {
            yield { type: "token" as const, token: "still works" };
          },
        },
      }),
    );

    const events = [];
    for await (const event of core.stream(
      [{ role: "user", content: "prompt" }],
      duel,
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "slot_error",
      slot: "A",
      message: "A exploded",
    });
    expect(events).toContainEqual({
      type: "token",
      slot: "B",
      token: "still works",
    });
    expect(events.at(-1)).toEqual({ type: "matchup_done" });
  });

  it("stops streaming promptly when the control-plane signal aborts", async () => {
    const controller = new AbortController();
    const core = new ArenaCore(
      new Resolver({
        a: {
          async *stream() {
            for (let index = 0; index < 100; index += 1) {
              yield { type: "token" as const, token: `A${index}` };
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
          },
        },
        b: {
          async *stream() {
            yield { type: "token" as const, token: "B" };
            await new Promise((resolve) => setTimeout(resolve, 10_000));
          },
        },
      }),
    );

    const events = [];
    for await (const event of core.stream(
      [{ role: "user", content: "prompt" }],
      duel,
      controller.signal,
    )) {
      events.push(event);
      if (event.type === "token") {
        controller.abort();
      }
    }

    expect(events.length).toBeGreaterThan(0);
    // Abort cuts the stream short — the 100-token producer never drains.
    expect(events.filter((event) => event.type === "token").length).toBeLessThan(
      100,
    );
  });

  it("yields nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const core = new ArenaCore(
      new Resolver({
        a: {
          async *stream() {
            yield { type: "token" as const, token: "A" };
          },
        },
        b: {
          async *stream() {
            yield { type: "token" as const, token: "B" };
          },
        },
      }),
    );

    const events = [];
    for await (const event of core.stream(
      [{ role: "user", content: "prompt" }],
      duel,
      controller.signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([]);
  });
});
