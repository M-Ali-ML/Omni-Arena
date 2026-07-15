import { describe, expect, it } from "vitest";
import type {
  MatchmakingStats,
  MatchmakingStatsPort,
  Model,
  PairSampleCount,
} from "../core/ports.js";
import { SmartMatchmaker } from "./smart.js";

function makeModels(count: number): Model[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `model_${index}`,
    displayName: `Model ${index}`,
    provider: "test",
    providerModelId: `test-${index}`,
    enabled: true,
  }));
}

function statsPort(stats: MatchmakingStats): MatchmakingStatsPort {
  return { getMatchmakingStats: async () => stats };
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

async function tallyPairs(
  matchmaker: SmartMatchmaker,
  draws: number,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let i = 0; i < draws; i += 1) {
    const { modelA, modelB } = await matchmaker.pick();
    const key = pairKey(modelA.id, modelB.id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe("SmartMatchmaker", () => {
  it("rejects when fewer than two models are enabled", async () => {
    const matchmaker = new SmartMatchmaker(
      statsPort({ models: makeModels(1), pairGames: [], ratingUncertainty: {} }),
    );
    await expect(matchmaker.pick()).rejects.toThrow(
      "At least two enabled models",
    );
  });

  it("favors the under-sampled pair over well-sampled ones", async () => {
    const models = makeModels(3);
    const [m0, m1, m2] = models as [Model, Model, Model];
    // (0,1) has never been played; the other two pairs are heavily sampled.
    const pairGames: PairSampleCount[] = [
      { modelAId: m0.id, modelBId: m2.id, games: 100 },
      { modelAId: m1.id, modelBId: m2.id, games: 100 },
    ];
    // Equal, narrow uncertainty everywhere so the coldness term dominates.
    const ratingUncertainty = { [m0.id]: 10, [m1.id]: 10, [m2.id]: 10 };
    const matchmaker = new SmartMatchmaker(
      statsPort({ models, pairGames, ratingUncertainty }),
    );

    const counts = await tallyPairs(matchmaker, 3000);
    const cold = counts.get(pairKey(m0.id, m1.id)) ?? 0;
    const warmA = counts.get(pairKey(m0.id, m2.id)) ?? 0;
    const warmB = counts.get(pairKey(m1.id, m2.id)) ?? 0;

    // The cold pair should dominate and beat the uniform 1/3 share (1000).
    expect(cold).toBeGreaterThan(warmA);
    expect(cold).toBeGreaterThan(warmB);
    expect(cold).toBeGreaterThan(1000);
  });

  it("favors high-variance matchups when sampling is equal", async () => {
    const models = makeModels(3);
    const [m0, m1, m2] = models as [Model, Model, Model];
    // Every pair equally sampled; only model 2's rating interval is wide.
    const pairGames: PairSampleCount[] = [
      { modelAId: m0.id, modelBId: m1.id, games: 50 },
      { modelAId: m0.id, modelBId: m2.id, games: 50 },
      { modelAId: m1.id, modelBId: m2.id, games: 50 },
    ];
    const ratingUncertainty = { [m0.id]: 10, [m1.id]: 10, [m2.id]: 400 };
    const matchmaker = new SmartMatchmaker(
      statsPort({ models, pairGames, ratingUncertainty }),
    );

    const counts = await tallyPairs(matchmaker, 3000);
    const lowVariance = counts.get(pairKey(m0.id, m1.id)) ?? 0;
    const highA = counts.get(pairKey(m0.id, m2.id)) ?? 0;
    const highB = counts.get(pairKey(m1.id, m2.id)) ?? 0;

    // Pairs containing the wide-interval model are preferred.
    expect(highA).toBeGreaterThan(lowVariance);
    expect(highB).toBeGreaterThan(lowVariance);
  });

  it("explores unrated models as if maximally uncertain", async () => {
    const models = makeModels(3);
    const [m0, m1, m2] = models as [Model, Model, Model];
    const pairGames: PairSampleCount[] = [
      { modelAId: m0.id, modelBId: m1.id, games: 50 },
      { modelAId: m0.id, modelBId: m2.id, games: 50 },
      { modelAId: m1.id, modelBId: m2.id, games: 50 },
    ];
    // Only 0 and 1 are rated (narrow); model 2 has no rating at all.
    const ratingUncertainty = { [m0.id]: 10, [m1.id]: 10 };
    const matchmaker = new SmartMatchmaker(
      statsPort({ models, pairGames, ratingUncertainty }),
    );

    const counts = await tallyPairs(matchmaker, 3000);
    const rated = counts.get(pairKey(m0.id, m1.id)) ?? 0;
    const unratedA = counts.get(pairKey(m0.id, m2.id)) ?? 0;
    const unratedB = counts.get(pairKey(m1.id, m2.id)) ?? 0;

    expect(unratedA).toBeGreaterThan(rated);
    expect(unratedB).toBeGreaterThan(rated);
  });

  it("assigns the chosen pair to slots based on the swap draw", async () => {
    const models = makeModels(2);
    const [m0, m1] = models as [Model, Model];
    const stats = statsPort({
      models,
      pairGames: [{ modelAId: m0.id, modelBId: m1.id, games: 5 }],
      ratingUncertainty: { [m0.id]: 10, [m1.id]: 10 },
    });
    // Only one pair exists, so the pair-selection draw is irrelevant; the
    // second draw decides the swap.
    const noSwap = new SmartMatchmaker(stats, () => 0);
    const straight = await noSwap.pick();
    expect(straight.slotA.id).toBe(straight.modelA.id);
    expect(straight.slotB.id).toBe(straight.modelB.id);

    const draws = [0, 0.9];
    const swapping = new SmartMatchmaker(stats, () => draws.shift() ?? 0);
    const swapped = await swapping.pick();
    expect(swapped.slotA.id).toBe(swapped.modelB.id);
    expect(swapped.slotB.id).toBe(swapped.modelA.id);
  });
});
