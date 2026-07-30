import { describe, expect, it } from "vitest";
import type { Model } from "../core/ports.js";
import {
  assertArenaModeConfig,
  parseArenaModeConfig,
  resolveArenaDefaultModel,
  resolveArenaPlan,
  type ArenaModeConfig,
} from "./mode.js";

const always: ArenaModeConfig = { trigger: "always", defaultModel: null };
const manual: ArenaModeConfig = { trigger: "manual", defaultModel: "gpt" };

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

describe("resolveArenaDefaultModel", () => {
  it("resolves a provider_model_id slug to the model UUID", () => {
    expect(
      resolveArenaDefaultModel(
        { trigger: "manual", defaultModel: "mock-alpha" },
        enabledModels,
      ),
    ).toEqual({ trigger: "manual", defaultModel: alpha.id });
  });

  it("resolves provider:provider_model_id to the model UUID", () => {
    expect(
      resolveArenaDefaultModel(
        { trigger: "manual", defaultModel: "mock:mock-beta" },
        enabledModels,
      ),
    ).toEqual({ trigger: "manual", defaultModel: beta.id });
  });

  it("keeps accepting a models.id UUID", () => {
    expect(
      resolveArenaDefaultModel(
        { trigger: "manual", defaultModel: alpha.id },
        enabledModels,
      ),
    ).toEqual({ trigger: "manual", defaultModel: alpha.id });
  });

  it("fails at boot when the identifier matches no enabled model", () => {
    expect(() =>
      resolveArenaDefaultModel(
        { trigger: "manual", defaultModel: "does-not-exist" },
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
        { trigger: "manual", defaultModel: "Mock Model Alpha" },
        enabledModels,
      ),
    ).toEqual({ trigger: "manual", defaultModel: alpha.id });
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
