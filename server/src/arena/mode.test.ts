import { describe, expect, it } from "vitest";
import type { Model } from "../core/ports.js";
import {
  assertArenaModeConfig,
  parseArenaModeConfig,
  resolveArenaDefaultModel,
  resolveArenaPlan,
  type ArenaModeConfig,
} from "./mode.js";

const always: ArenaModeConfig = {
  trigger: "always",
  defaultModel: null,
  sampleRate: 0,
};
const manual: ArenaModeConfig = {
  trigger: "manual",
  defaultModel: "gpt",
  sampleRate: 0,
};
const sampled = (rate: number): ArenaModeConfig => ({
  trigger: "sampled",
  defaultModel: "gpt",
  sampleRate: rate,
});

const alpha: Model = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Mock Model Alpha",
  provider: "mock",
  providerModelId: "mock-alpha",
  enabled: true,
};
const beta: Model = {
  id: "22222222-2222-4222-8222-222222222222",
  displayName: "Mock Model Beta",
  provider: "mock",
  providerModelId: "mock-beta",
  enabled: true,
};
const enabledModels = [alpha, beta];

// always/manual do not branch on rng; a throwing stub proves it stays unused.
const unusedRng = (): number => {
  throw new Error("rng should not be consumed for always/manual");
};

/** Deterministic mulberry32 PRNG for distribution tests. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("parseArenaModeConfig", () => {
  it("defaults to the always trigger with no default model", () => {
    expect(parseArenaModeConfig({})).toEqual({
      trigger: "always",
      defaultModel: null,
      sampleRate: 0,
    });
  });

  it("reads trigger and default model from env", () => {
    expect(
      parseArenaModeConfig({
        ARENA_TRIGGER: "manual",
        ARENA_DEFAULT_MODEL: "gemini-flash",
      }),
    ).toEqual({
      trigger: "manual",
      defaultModel: "gemini-flash",
      sampleRate: 0,
    });
  });

  it("reads sampled trigger and sample rate from env", () => {
    expect(
      parseArenaModeConfig({
        ARENA_TRIGGER: "sampled",
        ARENA_DEFAULT_MODEL: "gemini-flash",
        ARENA_SAMPLE_RATE: "0.05",
      }),
    ).toEqual({
      trigger: "sampled",
      defaultModel: "gemini-flash",
      sampleRate: 0.05,
    });
  });

  it("treats a blank default model as unset", () => {
    expect(
      parseArenaModeConfig({ ARENA_DEFAULT_MODEL: "   " }).defaultModel,
    ).toBeNull();
  });

  it("rejects an unknown trigger", () => {
    expect(() => parseArenaModeConfig({ ARENA_TRIGGER: "targeted" })).toThrow();
  });

  it("rejects a sample rate outside 0..1", () => {
    expect(() =>
      parseArenaModeConfig({ ARENA_SAMPLE_RATE: "1.5" }),
    ).toThrow();
    expect(() =>
      parseArenaModeConfig({ ARENA_SAMPLE_RATE: "-0.1" }),
    ).toThrow();
  });
});

describe("assertArenaModeConfig", () => {
  it("accepts always without a default model", () => {
    expect(() => assertArenaModeConfig(always)).not.toThrow();
  });

  it("accepts manual with a default model", () => {
    expect(() => assertArenaModeConfig(manual)).not.toThrow();
  });

  it("accepts sampled with a default model", () => {
    expect(() => assertArenaModeConfig(sampled(0.1))).not.toThrow();
  });

  it("fails fast when manual has no default model", () => {
    expect(() =>
      assertArenaModeConfig({
        trigger: "manual",
        defaultModel: null,
        sampleRate: 0,
      }),
    ).toThrow(/ARENA_DEFAULT_MODEL is required/);
  });

  it("fails fast when sampled has no default model", () => {
    expect(() =>
      assertArenaModeConfig({
        trigger: "sampled",
        defaultModel: null,
        sampleRate: 0.1,
      }),
    ).toThrow(/ARENA_DEFAULT_MODEL is required when ARENA_TRIGGER=sampled/);
  });
});

describe("resolveArenaDefaultModel", () => {
  it("resolves a provider_model_id slug to the model UUID", () => {
    expect(
      resolveArenaDefaultModel(
        { trigger: "manual", defaultModel: "mock-alpha", sampleRate: 0 },
        enabledModels,
      ),
    ).toEqual({
      trigger: "manual",
      defaultModel: alpha.id,
      sampleRate: 0,
    });
  });

  it("resolves provider:provider_model_id to the model UUID", () => {
    expect(
      resolveArenaDefaultModel(
        { trigger: "manual", defaultModel: "mock:mock-beta", sampleRate: 0 },
        enabledModels,
      ),
    ).toEqual({
      trigger: "manual",
      defaultModel: beta.id,
      sampleRate: 0,
    });
  });

  it("keeps accepting a models.id UUID", () => {
    expect(
      resolveArenaDefaultModel(
        { trigger: "manual", defaultModel: alpha.id, sampleRate: 0 },
        enabledModels,
      ),
    ).toEqual({
      trigger: "manual",
      defaultModel: alpha.id,
      sampleRate: 0,
    });
  });

  it("fails at boot when the identifier matches no enabled model", () => {
    expect(() =>
      resolveArenaDefaultModel(
        { trigger: "manual", defaultModel: "does-not-exist", sampleRate: 0 },
        enabledModels,
      ),
    ).toThrow(
      /ARENA_DEFAULT_MODEL 'does-not-exist' matched none of the enabled models[\s\S]*mock:mock-alpha[\s\S]*mock:mock-beta/,
    );
  });

  it("leaves an unset default model unchanged", () => {
    expect(resolveArenaDefaultModel(always, enabledModels)).toEqual(always);
  });

  it("resolves a display_name to the model UUID", () => {
    expect(
      resolveArenaDefaultModel(
        {
          trigger: "manual",
          defaultModel: "Mock Model Alpha",
          sampleRate: 0,
        },
        enabledModels,
      ),
    ).toEqual({
      trigger: "manual",
      defaultModel: alpha.id,
      sampleRate: 0,
    });
  });
});

describe("resolveArenaPlan", () => {
  it("always → matchup regardless of opt-in", () => {
    expect(resolveArenaPlan(always, {}, unusedRng)).toEqual({ kind: "matchup" });
    expect(resolveArenaPlan(always, { arena: true }, unusedRng)).toEqual({
      kind: "matchup",
    });
  });

  it("manual with no opt-in → single", () => {
    expect(resolveArenaPlan(manual, {}, unusedRng)).toEqual({ kind: "single" });
    expect(resolveArenaPlan(manual, { arena: false }, unusedRng)).toEqual({
      kind: "single",
    });
  });

  it("manual + body arena:true → matchup", () => {
    expect(resolveArenaPlan(manual, { arena: true }, unusedRng)).toEqual({
      kind: "matchup",
    });
  });

  it("manual + x-arena:on header → matchup (case-insensitive)", () => {
    expect(resolveArenaPlan(manual, { header: "on" }, unusedRng)).toEqual({
      kind: "matchup",
    });
    expect(resolveArenaPlan(manual, { header: "ON" }, unusedRng)).toEqual({
      kind: "matchup",
    });
  });

  it("manual + unrelated header value → single", () => {
    expect(resolveArenaPlan(manual, { header: "off" }, unusedRng)).toEqual({
      kind: "single",
    });
  });

  it("sampled at rate 0 → always single", () => {
    const rng = seededRng(1);
    for (let i = 0; i < 50; i++) {
      expect(resolveArenaPlan(sampled(0), {}, rng)).toEqual({ kind: "single" });
    }
  });

  it("sampled at rate 1 → always matchup", () => {
    const rng = seededRng(2);
    for (let i = 0; i < 50; i++) {
      expect(resolveArenaPlan(sampled(1), {}, rng)).toEqual({
        kind: "matchup",
      });
    }
  });

  it("sampled at rate 0.5 → ~half matchups over many draws", () => {
    const draws = 2000;
    const rng = seededRng(42);
    let hits = 0;
    for (let i = 0; i < draws; i++) {
      if (resolveArenaPlan(sampled(0.5), {}, rng).kind === "matchup") {
        hits += 1;
      }
    }
    const rate = hits / draws;
    // Binomial SE at p=0.5, N=2000 is ~0.011; ±0.05 is a comfortable band.
    expect(rate).toBeGreaterThan(0.45);
    expect(rate).toBeLessThan(0.55);
  });
});
