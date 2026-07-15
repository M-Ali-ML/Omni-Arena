import type {
  MatchmakingPort,
  MatchmakingStats,
  MatchmakingStatsPort,
  MatchupAssignment,
  Model,
} from "../core/ports.js";

/**
 * Canonical (order-independent) key for a model pair, so `(a, b)` and `(b, a)`
 * map to the same bucket regardless of slot orientation.
 */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export interface SmartMatchmakerOptions {
  /** Weight on how under-sampled a pair is (few prior games). */
  coldnessWeight?: number;
  /** Weight on how uncertain the pair's two models are (wide rating CIs). */
  varianceWeight?: number;
  /**
   * Floor added to every pair's score so well-sampled, confident pairs keep a
   * small selection probability — the graph stays connected and no pair is
   * ever starved entirely.
   */
  floor?: number;
}

const DEFAULTS: Required<SmartMatchmakerOptions> = {
  coldnessWeight: 1,
  varianceWeight: 1,
  floor: 0.02,
};

interface ScoredPair {
  modelA: Model;
  modelB: Model;
  score: number;
}

/**
 * Active-learning matchmaker: instead of sampling pairs uniformly, it weights
 * each candidate pair by how much a fresh vote would sharpen the leaderboard —
 * favouring **under-evaluated pairs** (few games) and **high-variance matchups**
 * (models whose Bradley-Terry rating intervals are still wide, including models
 * the worker has not rated yet). Selection is proportional to that weight
 * rather than greedy, so exploration stays stochastic and every pair keeps a
 * nonzero chance. It is a drop-in `MatchmakingPort`; `RandomMatchmaker` remains
 * the simple fallback.
 */
export class SmartMatchmaker implements MatchmakingPort {
  private readonly options: Required<SmartMatchmakerOptions>;

  constructor(
    private readonly stats: MatchmakingStatsPort,
    private readonly random: () => number = Math.random,
    options: SmartMatchmakerOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  async pick(): Promise<MatchupAssignment> {
    const { models, pairGames, ratingUncertainty } =
      await this.stats.getMatchmakingStats();
    if (models.length < 2) {
      throw new Error("At least two enabled models are required");
    }

    const gamesByPair = new Map<string, number>();
    for (const { modelAId, modelBId, games } of pairGames) {
      gamesByPair.set(pairKey(modelAId, modelBId), games);
    }

    // A model with no rating yet has no measured interval, so it is treated as
    // strictly more uncertain than any rated model (twice the widest observed
    // width) — cold-start models should be explored first. Widths are then
    // normalised to [0, 1] by the largest effective width so the variance term
    // is comparable to the coldness term.
    const ratedWidths = Object.values(ratingUncertainty);
    const maxRated = ratedWidths.length ? Math.max(...ratedWidths, 0) : 0;
    const anyUnrated = models.some(
      (model) => ratingUncertainty[model.id] === undefined,
    );
    const unratedWidth = maxRated > 0 ? maxRated * 2 : 1;
    const denominator = anyUnrated ? unratedWidth : maxRated > 0 ? maxRated : 1;
    const uncertaintyOf = (id: string): number => {
      const width = ratingUncertainty[id] ?? unratedWidth;
      return width / denominator;
    };

    const scored: ScoredPair[] = [];
    let total = 0;
    for (let i = 0; i < models.length; i += 1) {
      for (let j = i + 1; j < models.length; j += 1) {
        const modelA = models[i];
        const modelB = models[j];
        if (!modelA || !modelB) {
          continue;
        }
        const games = gamesByPair.get(pairKey(modelA.id, modelB.id)) ?? 0;
        const coldness = 1 / (1 + games);
        const variance =
          (uncertaintyOf(modelA.id) + uncertaintyOf(modelB.id)) / 2;
        const score =
          this.options.floor +
          this.options.coldnessWeight * coldness +
          this.options.varianceWeight * variance;
        scored.push({ modelA, modelB, score });
        total += score;
      }
    }

    const chosen = this.sample(scored, total);
    const swapSlots = this.random() >= 0.5;
    return {
      modelA: chosen.modelA,
      modelB: chosen.modelB,
      slotA: swapSlots ? chosen.modelB : chosen.modelA,
      slotB: swapSlots ? chosen.modelA : chosen.modelB,
    };
  }

  /** Weighted reservoir pick: probability of a pair is score / total. */
  private sample(scored: ScoredPair[], total: number): ScoredPair {
    let threshold = this.random() * total;
    for (const pair of scored) {
      threshold -= pair.score;
      if (threshold < 0) {
        return pair;
      }
    }
    // Floating-point guard: fall back to the last candidate.
    const last = scored[scored.length - 1];
    if (!last) {
      throw new Error("Failed to select a model pair");
    }
    return last;
  }
}
