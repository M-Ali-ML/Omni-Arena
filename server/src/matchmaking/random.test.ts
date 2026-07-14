import { describe, expect, it } from "vitest";
import type { Model, PreferenceRepositoryPort } from "../core/ports.js";
import { RandomMatchmaker } from "./random.js";

function makeModels(count: number): Model[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `model_${index}`,
    displayName: `Model ${index}`,
    provider: "test",
    providerModelId: `test-${index}`,
    enabled: true,
  }));
}

function repoWith(models: Model[]): PreferenceRepositoryPort {
  return {
    listEnabledModels: async () => models,
    createMatchup: async () => {},
    saveResponse: async () => {},
    recordPreference: async () => {},
    getMatchup: async () => null,
  };
}

describe("RandomMatchmaker", () => {
  it("rejects when fewer than two models are enabled", async () => {
    const matchmaker = new RandomMatchmaker(repoWith(makeModels(1)));
    await expect(matchmaker.pick()).rejects.toThrow(
      "At least two enabled models",
    );
  });

  it("always picks two distinct models", async () => {
    const matchmaker = new RandomMatchmaker(repoWith(makeModels(3)));
    for (let i = 0; i < 200; i += 1) {
      const assignment = await matchmaker.pick();
      expect(assignment.modelA.id).not.toBe(assignment.modelB.id);
      expect(assignment.slotA.id).not.toBe(assignment.slotB.id);
      expect(new Set([assignment.slotA.id, assignment.slotB.id])).toEqual(
        new Set([assignment.modelA.id, assignment.modelB.id]),
      );
    }
  });

  it("assigns the pair to slots based on the swap draw", async () => {
    const models = makeModels(2);
    // draws: firstIndex, secondIndex, swap decision
    const noSwap = new RandomMatchmaker(repoWith(models), () => 0);
    const straight = await noSwap.pick();
    expect(straight.slotA.id).toBe(straight.modelA.id);
    expect(straight.slotB.id).toBe(straight.modelB.id);

    const draws = [0, 0, 0.9];
    const swapping = new RandomMatchmaker(
      repoWith(models),
      () => draws.shift() ?? 0,
    );
    const swapped = await swapping.pick();
    expect(swapped.slotA.id).toBe(swapped.modelB.id);
    expect(swapped.slotB.id).toBe(swapped.modelA.id);
  });

  it("covers every unordered pair over many draws", async () => {
    const matchmaker = new RandomMatchmaker(repoWith(makeModels(3)));
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const { modelA, modelB } = await matchmaker.pick();
      seen.add([modelA.id, modelB.id].sort().join("|"));
    }
    expect(seen.size).toBe(3);
  });
});
