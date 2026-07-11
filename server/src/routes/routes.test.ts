import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { ArenaCore } from "../core/arena.js";
import type {
  ArenaVote,
  LeaderboardEntry,
  MatchupAssignment,
  MatchupRecord,
  Model,
  PreferenceRecord,
  PreferenceRepositoryPort,
  ResponseRecord,
} from "../core/ports.js";
import { ProviderRegistry } from "../providers/registry.js";
import { DuplicateVoteError } from "../repo/postgres.js";
import { MatchupTokenService } from "../token.js";

const slotA: Model = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "Secret Alpha",
  provider: "test",
  providerModelId: "alpha",
  enabled: true,
};
const slotB: Model = {
  id: "00000000-0000-4000-8000-000000000002",
  displayName: "Secret Beta",
  provider: "test",
  providerModelId: "beta",
  enabled: true,
};
const assignment: MatchupAssignment = {
  modelA: slotA,
  modelB: slotB,
  slotA,
  slotB,
};

class MemoryRepository implements PreferenceRepositoryPort {
  readonly matchups = new Map<string, MatchupRecord>();
  readonly responses: ResponseRecord[] = [];
  readonly preferences = new Map<string, PreferenceRecord>();

  async listEnabledModels(): Promise<Model[]> {
    return [slotA, slotB];
  }

  async createMatchup(matchup: MatchupRecord): Promise<void> {
    this.matchups.set(matchup.id, matchup);
  }

  async saveResponse(response: ResponseRecord): Promise<void> {
    this.responses.push(response);
  }

  async recordPreference(preference: PreferenceRecord): Promise<void> {
    if (this.preferences.has(preference.matchupId)) {
      throw new DuplicateVoteError();
    }
    this.preferences.set(preference.matchupId, preference);
  }

  async getMatchup(matchupId: string) {
    const matchup = this.matchups.get(matchupId);
    return matchup
      ? {
          id: matchup.id,
          matchupTokenHash: matchup.matchupTokenHash,
          slotA,
          slotB,
        }
      : null;
  }

  async getLeaderboard(): Promise<LeaderboardEntry[]> {
    const preference = [...this.preferences.values()][0];
    return [slotA, slotB].map((model) => {
      const isDecisive =
        preference?.vote === "left" || preference?.vote === "right";
      const wins = preference?.winnerModelId === model.id ? 1 : 0;
      const losses = isDecisive && wins === 0 ? 1 : 0;
      const ties =
        preference?.vote === "both_good" || preference?.vote === "both_bad"
          ? 1
          : 0;
      return {
        id: model.id,
        displayName: model.displayName,
        wins,
        losses,
        ties,
        skips: preference?.vote === "skip" ? 1 : 0,
        totalVotes: preference ? 1 : 0,
        winRate: wins + losses + ties === 0 ? 0 : wins / (wins + losses + ties),
      };
    });
  }
}

function parseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim(),
    )
    .filter((data): data is string => Boolean(data))
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

async function setup() {
  const repository = new MemoryRepository();
  const provider = {
    async *stream(model: Model) {
      yield `Answer from ${model.providerModelId}`;
    },
  };
  const app = await createApp({
    core: new ArenaCore(new ProviderRegistry().register("test", provider)),
    matchmaker: { async pick() { return assignment; } },
    repository,
    tokens: new MatchupTokenService("test-secret-long-enough"),
  });
  return { app, repository };
}

describe("arena routes", () => {
  it("masks identities until a valid vote and rejects token tampering", async () => {
    const { app, repository } = await setup();
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: { prompt: "Hello", sessionId: "anon_test" },
      });
      expect(chat.statusCode).toBe(200);

      const events = parseEvents(chat.body);
      const started = events[0];
      expect(started?.type).toBe("matchup_started");
      expect(JSON.stringify(started)).not.toContain(slotA.displayName);
      expect(JSON.stringify(started)).not.toContain(slotB.displayName);

      const matchupId = started?.matchupId as string;
      const matchupToken = started?.matchupToken as string;
      const invalid = await app.inject({
        method: "POST",
        url: "/api/arena/vote",
        payload: {
          matchupId,
          matchupToken: `${matchupToken.slice(0, -1)}x`,
          vote: "left" satisfies ArenaVote,
        },
      });
      expect(invalid.statusCode).toBe(401);

      const vote = await app.inject({
        method: "POST",
        url: "/api/arena/vote",
        payload: { matchupId, matchupToken, vote: "left" },
      });
      expect(vote.statusCode).toBe(200);
      expect(vote.json().models).toEqual({
        A: { id: slotA.id, displayName: slotA.displayName },
        B: { id: slotB.id, displayName: slotB.displayName },
      });
      expect(repository.responses).toHaveLength(2);

      const leaderboard = await app.inject({
        method: "GET",
        url: "/api/arena/leaderboard",
      });
      expect(leaderboard.statusCode).toBe(200);
      expect(leaderboard.json().models[0]).toMatchObject({
        id: slotA.id,
        wins: 1,
        winRate: 1,
      });

      const duplicate = await app.inject({
        method: "POST",
        url: "/api/arena/vote",
        payload: { matchupId, matchupToken, vote: "right" },
      });
      expect(duplicate.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});
