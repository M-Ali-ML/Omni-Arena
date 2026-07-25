import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useArenaLeaderboard } from "./useArenaLeaderboard.js";

const model = {
  id: "model_1",
  displayName: "Alpha",
  wins: 3,
  losses: 1,
  ties: 0,
  skips: 0,
  totalVotes: 4,
  winRate: 0.75,
  rating: 1120.4,
  ratingStdError: 40,
  confidenceInterval: { lower: 1042, upper: 1199 },
  componentId: 1,
  styleControlledRating: 1080.1,
  styleControlledStdError: 42,
  styleControlledConfidenceInterval: { lower: 998, upper: 1163 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useArenaLeaderboard", () => {
  it("exposes the connectivity and style-control context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          models: [model],
          components: {
            count: 2,
            groups: [
              { componentId: 0, models: 3 },
              { componentId: 1, models: 1 },
            ],
          },
          styleControl: {
            effects: [
              {
                feature: "verbosity",
                logOdds: 0.1,
                points: 17.37,
                basis: "per_std_dev",
                perUnit: { points: 34.74, unit: "100 output tokens" },
              },
            ],
            votesObserved: 120,
            computedAt: "2026-07-24T10:00:00.000Z",
          },
        }),
      ),
    );
    const { result } = renderHook(() => useArenaLeaderboard());

    await waitFor(() => {
      expect(result.current.models).toHaveLength(1);
    });
    expect(result.current.components.count).toBe(2);
    expect(result.current.components.groups[1]).toEqual({
      componentId: 1,
      models: 1,
    });
    expect(result.current.styleControl.effects[0]?.perUnit).toEqual({
      points: 34.74,
      unit: "100 output tokens",
    });
    expect(result.current.styleControl.votesObserved).toBe(120);
  });

  it("falls back to an empty context on servers that omit it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ models: [model] })),
    );
    const { result } = renderHook(() => useArenaLeaderboard());

    await waitFor(() => {
      expect(result.current.models).toHaveLength(1);
    });
    expect(result.current.components).toEqual({ count: null, groups: [] });
    expect(result.current.styleControl).toEqual({
      effects: [],
      votesObserved: 0,
      computedAt: null,
    });
    expect(result.current.error).toBeNull();
  });
});
