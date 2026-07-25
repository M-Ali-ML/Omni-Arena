import { afterEach, describe, expect, it, vi } from "vitest";
import { submitArenaVote } from "./vote.js";

const revealed = {
  A: { id: "model_1", displayName: "Alpha" },
  B: { id: "model_2", displayName: "Beta" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submitArenaVote", () => {
  it("posts the matchup handles and resolves with the reveal", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ accepted: true, models: revealed }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const reveal = await submitArenaVote({
      matchupId: "m1",
      matchupToken: "t1",
      vote: "left",
      baseUrl: "https://arena.example.com",
    });

    expect(reveal).toEqual({ models: revealed, vote: "left" });
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toBe("https://arena.example.com/api/arena/vote");
    expect(call?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      matchupId: "m1",
      matchupToken: "t1",
      vote: "left",
    });
  });

  it("rejects with the server's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "Vote already recorded" }, { status: 409 }),
      ),
    );

    await expect(
      submitArenaVote({ matchupId: "m1", matchupToken: "t1", vote: "skip" }),
    ).rejects.toThrow("Vote already recorded");
  });

  it("rejects on a body that carries no reveal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gateway down", { status: 502 })),
    );

    await expect(
      submitArenaVote({ matchupId: "m1", matchupToken: "t1", vote: "right" }),
    ).rejects.toThrow("Vote failed (502)");
  });

  it("defaults to the same-origin route", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) =>
      Response.json({ models: revealed }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await submitArenaVote({
      matchupId: "m1",
      matchupToken: "t1",
      vote: "both_good",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/arena/vote");
  });
});
