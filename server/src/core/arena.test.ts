import { describe, expect, it } from "vitest";
import { ArenaCore } from "./arena.js";
import type {
  MatchupAssignment,
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

const assignment: MatchupAssignment = {
  modelA: model("a"),
  modelB: model("b"),
  slotA: model("a"),
  slotB: model("b"),
};

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
            yield "A1";
            await new Promise((resolve) => setTimeout(resolve, 10));
            yield "A2";
          },
        },
        b: {
          async *stream() {
            await new Promise((resolve) => setTimeout(resolve, 2));
            yield "B1";
          },
        },
      }),
    );

    const events = [];
    for await (const event of core.stream("prompt", assignment)) {
      events.push(event);
    }

    expect(
      events
        .filter((event) => event.type === "token")
        .map((event) => `${event.slot}:${event.token}`),
    ).toEqual(["A:A1", "B:B1", "A:A2"]);
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
            yield "still works";
          },
        },
      }),
    );

    const events = [];
    for await (const event of core.stream("prompt", assignment)) {
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
});
