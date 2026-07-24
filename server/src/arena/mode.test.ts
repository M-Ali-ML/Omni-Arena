import { describe, expect, it } from "vitest";
import {
  assertArenaModeConfig,
  parseArenaModeConfig,
  resolveArenaPlan,
  type ArenaModeConfig,
} from "./mode.js";

const always: ArenaModeConfig = { trigger: "always", defaultModel: null };
const manual: ArenaModeConfig = { trigger: "manual", defaultModel: "gpt" };

// Phase 1 does not branch on rng; a throwing stub proves it stays unused.
const unusedRng = (): number => {
  throw new Error("rng should not be consumed in Phase 1");
};

describe("parseArenaModeConfig", () => {
  it("defaults to the always trigger with no default model", () => {
    expect(parseArenaModeConfig({})).toEqual({
      trigger: "always",
      defaultModel: null,
    });
  });

  it("reads trigger and default model from env", () => {
    expect(
      parseArenaModeConfig({
        ARENA_TRIGGER: "manual",
        ARENA_DEFAULT_MODEL: "gemini-flash",
      }),
    ).toEqual({ trigger: "manual", defaultModel: "gemini-flash" });
  });

  it("treats a blank default model as unset", () => {
    expect(
      parseArenaModeConfig({ ARENA_DEFAULT_MODEL: "   " }).defaultModel,
    ).toBeNull();
  });

  it("rejects an unknown trigger", () => {
    expect(() => parseArenaModeConfig({ ARENA_TRIGGER: "sampled" })).toThrow();
  });
});

describe("assertArenaModeConfig", () => {
  it("accepts always without a default model", () => {
    expect(() => assertArenaModeConfig(always)).not.toThrow();
  });

  it("accepts manual with a default model", () => {
    expect(() => assertArenaModeConfig(manual)).not.toThrow();
  });

  it("fails fast when manual has no default model", () => {
    expect(() =>
      assertArenaModeConfig({ trigger: "manual", defaultModel: null }),
    ).toThrow(/ARENA_DEFAULT_MODEL is required/);
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
});
