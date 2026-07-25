import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useArenaActivity,
  useArenaRatingHistory,
  useArenaSummary,
} from "./useArenaAnalytics.js";

function mockJsonFetch(payload: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useArenaAnalytics hooks", () => {
  it("fetches the summary from the analytics route", async () => {
    const summary = { totalMatchups: 3, totalVotes: 2 };
    const fetchMock = mockJsonFetch(summary);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useArenaSummary());
    await waitFor(() => expect(result.current.data).not.toBeNull());

    expect(fetchMock).toHaveBeenCalledWith("/api/arena/analytics/summary");
    expect(result.current.data).toMatchObject(summary);
    expect(result.current.error).toBeNull();
  });

  it("threads the bucket and since params into the request URLs", async () => {
    const fetchMock = mockJsonFetch({ models: [], points: [] });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useArenaActivity({ bucket: "hour" }));
    renderHook(() =>
      useArenaRatingHistory({ since: "2026-07-01T00:00:00Z" }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/arena/analytics/activity?bucket=hour",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/arena/analytics/rating-history?since=2026-07-01T00%3A00%3A00Z",
    );
  });

  it("surfaces HTTP failures through the error field", async () => {
    vi.stubGlobal("fetch", mockJsonFetch({ error: "nope" }, 500));

    const { result } = renderHook(() => useArenaSummary());
    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.error).toContain("500");
    expect(result.current.data).toBeNull();
  });
});
