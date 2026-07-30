import { describe, expect, it } from "vitest";
import { createApp, type AppDependencies } from "../app.js";
import { ArenaCore } from "../core/arena.js";
import type {
  ActivityBucketSize,
  AnalyticsPort,
  ArenaSummary,
} from "../core/ports.js";
import { ProviderRegistry } from "../providers/registry.js";
import { MatchupTokenService } from "../token.js";

const summary: ArenaSummary = {
  totalMatchups: 6,
  totalVotes: 5,
  decisiveVotes: 3,
  tieVotes: 1,
  skipVotes: 1,
  slotAWins: 2,
  slotBWins: 1,
  enabledModels: 3,
  pairsSampled: 2,
  pairsPossible: 3,
  ratingComponents: 1,
};

class StubAnalytics implements AnalyticsPort {
  activityBucket: ActivityBucketSize | null = null;
  historySince: Date | null = null;

  async getSummary() {
    return summary;
  }

  async getHeadToHead() {
    return {
      models: [{ id: "m1", displayName: "Alpha" }],
      pairs: [
        {
          modelAId: "m1",
          modelBId: "m2",
          aWins: 2,
          bWins: 1,
          ties: 1,
          games: 4,
        },
      ],
    };
  }

  async getModelMetrics() {
    return [];
  }

  async getActivity(bucket: ActivityBucketSize) {
    this.activityBucket = bucket;
    return { bucket, models: [], votes: [], cumulativeGames: [] };
  }

  async getStyleControl() {
    return { coefficients: [], models: [] };
  }

  async getRatingHistory(since: Date | null) {
    this.historySince = since;
    return { models: [], points: [] };
  }
}

// The analytics routes never touch the chat pipeline, so the arena-side
// dependencies can be inert stubs.
function buildApp(analytics: AnalyticsPort | undefined) {
  const repository = {
    listEnabledModels: async () => [],
    createMatchup: async () => undefined,
    saveResponse: async () => undefined,
    recordSteer: async () => undefined,
    recordPreference: async () => undefined,
    getConversationContext: async () => ({ status: "not_found" as const }),
    getMatchup: async () => null,
    getConversationTurns: async () => ({ status: "not_found" as const }),
    getLeaderboard: async () => [],
    getRatingContext: async () => ({
      components: { count: null, groups: [] },
      styleControl: { effects: [], votesObserved: 0, computedAt: null },
    }),
  };
  const dependencies: AppDependencies = {
    core: new ArenaCore(new ProviderRegistry()),
    matchmaker: {
      async pick(): Promise<never> {
        throw new Error("matchmaker should not be called");
      },
    },
    repository,
    tokens: new MatchupTokenService("analytics-test-secret-long-enough"),
    harnessVersion: "test",
  };
  if (analytics) {
    dependencies.analytics = analytics;
  }
  return createApp(dependencies);
}

describe("analytics routes", () => {
  it("serves the summary payload", async () => {
    const app = await buildApp(new StubAnalytics());
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/arena/analytics/summary",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(summary);
    } finally {
      await app.close();
    }
  });

  it("serves head-to-head pairs", async () => {
    const app = await buildApp(new StubAnalytics());
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/arena/analytics/head-to-head",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().pairs).toHaveLength(1);
      expect(response.json().pairs[0]).toMatchObject({ games: 4 });
    } finally {
      await app.close();
    }
  });

  it("defaults activity to day buckets and validates the bucket param", async () => {
    const analytics = new StubAnalytics();
    const app = await buildApp(analytics);
    try {
      const defaulted = await app.inject({
        method: "GET",
        url: "/api/arena/analytics/activity",
      });
      expect(defaulted.statusCode).toBe(200);
      expect(analytics.activityBucket).toBe("day");

      const hourly = await app.inject({
        method: "GET",
        url: "/api/arena/analytics/activity?bucket=hour",
      });
      expect(hourly.statusCode).toBe(200);
      expect(analytics.activityBucket).toBe("hour");

      const invalid = await app.inject({
        method: "GET",
        url: "/api/arena/analytics/activity?bucket=week",
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("parses the rating-history since filter and rejects junk", async () => {
    const analytics = new StubAnalytics();
    const app = await buildApp(analytics);
    try {
      const unfiltered = await app.inject({
        method: "GET",
        url: "/api/arena/analytics/rating-history",
      });
      expect(unfiltered.statusCode).toBe(200);
      expect(analytics.historySince).toBeNull();

      const filtered = await app.inject({
        method: "GET",
        url: "/api/arena/analytics/rating-history?since=2026-07-01T00:00:00Z",
      });
      expect(filtered.statusCode).toBe(200);
      expect(analytics.historySince?.toISOString()).toBe(
        "2026-07-01T00:00:00.000Z",
      );

      const invalid = await app.inject({
        method: "GET",
        url: "/api/arena/analytics/rating-history?since=yesterday",
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("leaves the analytics routes unregistered when no port is provided", async () => {
    const app = await buildApp(undefined);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/arena/analytics/summary",
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
