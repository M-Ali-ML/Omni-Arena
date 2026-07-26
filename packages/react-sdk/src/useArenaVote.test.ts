import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useArenaVote } from "./useArenaVote.js";

const revealed = {
  A: { id: "model_1", displayName: "Alpha" },
  B: { id: "model_2", displayName: "Beta" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useArenaVote", () => {
  it("reveals the models for the configured round", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ accepted: true, models: revealed })),
    );
    const { result } = renderHook(() =>
      useArenaVote({ matchupId: "m1", matchupToken: "t1" }),
    );

    expect(result.current.canVote).toBe(true);
    await act(async () => {
      await result.current.vote("left");
    });

    expect(result.current.reveal).toEqual({
      models: revealed,
      vote: "left",
      continuable: true,
    });
    expect(result.current.isVoting).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.canVote).toBe(false);
  });

  it("keeps a rejection in state instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "Vote already recorded" }, { status: 409 }),
      ),
    );
    const { result } = renderHook(() =>
      useArenaVote({ matchupId: "m1", matchupToken: "t1" }),
    );

    let returned: unknown = "unset";
    await act(async () => {
      returned = await result.current.vote("right");
    });

    expect(returned).toBeNull();
    expect(result.current.error).toBe("Vote already recorded");
    expect(result.current.reveal).toBeNull();

    act(() => result.current.reset());
    expect(result.current.error).toBeNull();
  });

  it("refuses a round with no token and never calls the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useArenaVote({ matchupId: "m2", matchupToken: null }),
    );

    expect(result.current.canVote).toBe(false);
    await act(async () => {
      await result.current.vote("left");
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.error).toBe("This round cannot be voted on");
  });

  it("accepts a per-call target for a host that tracks many rounds", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ models: revealed }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useArenaVote());

    await act(async () => {
      await result.current.vote("skip", {
        matchupId: "m9",
        matchupToken: "t9",
      });
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      matchupId: "m9",
      matchupToken: "t9",
      vote: "skip",
    });
    expect(result.current.reveal?.vote).toBe("skip");
  });
});
