import type {
  MatchmakingPort,
  MatchupAssignment,
  PreferenceRepositoryPort,
} from "../core/ports.js";

export class RandomMatchmaker implements MatchmakingPort {
  constructor(
    private readonly repository: PreferenceRepositoryPort,
    private readonly random: () => number = Math.random,
  ) {}

  async pick(): Promise<MatchupAssignment> {
    const models = await this.repository.listEnabledModels();
    if (models.length < 2) {
      throw new Error("At least two enabled models are required");
    }

    const firstIndex = Math.floor(this.random() * models.length);
    let secondIndex = Math.floor(this.random() * (models.length - 1));
    if (secondIndex >= firstIndex) {
      secondIndex += 1;
    }

    const modelA = models[firstIndex];
    const modelB = models[secondIndex];
    if (!modelA || !modelB) {
      throw new Error("Failed to select a model pair");
    }

    const swapSlots = this.random() >= 0.5;
    return {
      modelA,
      modelB,
      slotA: swapSlots ? modelB : modelA,
      slotB: swapSlots ? modelA : modelB,
    };
  }
}
