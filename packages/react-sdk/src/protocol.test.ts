import { describe, expect, it } from "vitest";
import {
  ARENA_VOTE_VALUES,
  isArenaSlot,
  isArenaVote,
  isDecisiveVote,
  parseArenaMatchup,
  parseArenaReveal,
  parseArenaSlotError,
} from "./protocol.js";

describe("parseArenaMatchup", () => {
  it("normalises a votable round", () => {
    expect(
      parseArenaMatchup({
        type: "matchup_started",
        matchupId: "m1",
        matchupToken: "t1",
        conversationId: "c1",
        turnIndex: 2,
        slots: ["A", "B"],
        mode: "matchup",
        votable: true,
      }),
    ).toEqual({
      matchupId: "m1",
      matchupToken: "t1",
      conversationId: "c1",
      turnIndex: 2,
      slots: ["A", "B"],
      mode: "matchup",
      votable: true,
    });
  });

  it("omits the identifiers a single round does not carry", () => {
    const parsed = parseArenaMatchup({
      matchupId: "m2",
      mode: "single",
      votable: false,
      slots: ["A"],
    });

    expect(parsed).toEqual({
      matchupId: "m2",
      matchupToken: null,
      slots: ["A"],
      mode: "single",
      votable: false,
    });
    expect(parsed).not.toHaveProperty("conversationId");
    expect(parsed).not.toHaveProperty("turnIndex");
  });

  it("treats an empty token as absent and defaults votable for older servers", () => {
    expect(parseArenaMatchup({ matchupId: "m3", matchupToken: "" })).toEqual({
      matchupId: "m3",
      matchupToken: null,
      slots: ["A", "B"],
      mode: "matchup",
      votable: true,
    });
  });

  it("rejects a payload with no matchup id", () => {
    expect(parseArenaMatchup({ matchupToken: "t1" })).toBeNull();
    expect(parseArenaMatchup(null)).toBeNull();
    expect(parseArenaMatchup("m1")).toBeNull();
  });
});

describe("parseArenaReveal", () => {
  it("reads both slots and the vote", () => {
    expect(
      parseArenaReveal({
        accepted: true,
        vote: "left",
        models: {
          A: { id: "model_1", displayName: "Alpha" },
          B: { id: "model_2", displayName: "Beta" },
        },
      }),
    ).toEqual({
      models: {
        A: { id: "model_1", displayName: "Alpha" },
        B: { id: "model_2", displayName: "Beta" },
      },
      vote: "left",
      // Derived here: this response predates the server's own `continuable`.
      continuable: true,
    });
  });

  it("prefers the server's continuation answer over the derived one", () => {
    expect(
      parseArenaReveal({
        accepted: true,
        vote: "left",
        continuable: false,
        conversationId: "conv_1",
        models: {
          A: { id: "model_1", displayName: "Alpha" },
          B: { id: "model_2", displayName: "Beta" },
        },
      }),
    ).toMatchObject({ continuable: false, conversationId: "conv_1" });
  });

  it("falls back to the display name when an adapter drops the id", () => {
    const reveal = parseArenaReveal({
      models: { A: { displayName: "Alpha" }, B: { displayName: "Beta" } },
    });

    expect(reveal?.models.A).toEqual({ id: "Alpha", displayName: "Alpha" });
    expect(reveal?.vote).toBeNull();
  });

  it("rejects a half reveal", () => {
    expect(
      parseArenaReveal({ models: { A: { displayName: "Alpha" } } }),
    ).toBeNull();
    expect(parseArenaReveal({ accepted: true })).toBeNull();
  });
});

describe("vote helpers", () => {
  it("treats only left and right as decisive", () => {
    expect(ARENA_VOTE_VALUES.filter(isDecisiveVote)).toEqual(["left", "right"]);
  });

  it("guards slots and votes", () => {
    expect(isArenaSlot("A")).toBe(true);
    expect(isArenaSlot("C")).toBe(false);
    expect(isArenaVote("skip")).toBe(true);
    expect(isArenaVote("maybe")).toBe(false);
  });
});

describe("parseArenaSlotError", () => {
  it("reads a slot failure and defaults the message", () => {
    expect(parseArenaSlotError({ slot: "B", message: "Provider exploded" })).toEqual(
      { slot: "B", message: "Provider exploded" },
    );
    expect(parseArenaSlotError({ slot: "A" })).toEqual({
      slot: "A",
      message: "Slot failed",
    });
    expect(parseArenaSlotError({ message: "no slot" })).toBeNull();
  });
});
