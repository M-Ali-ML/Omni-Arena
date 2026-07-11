import { describe, expect, it } from "vitest";
import { MatchupTokenService } from "./token.js";

const claims = {
  matchupId: "matchup",
  slotAModelId: "model-a",
  slotBModelId: "model-b",
  sessionId: "session",
};

describe("MatchupTokenService", () => {
  it("rejects tampered tokens", () => {
    const service = new MatchupTokenService("a-secret-long-enough");
    const { token } = service.issue(claims, 1_000_000);
    expect(() =>
      service.verify(`${token.slice(0, -1)}x`, 1_000_000),
    ).toThrow("Invalid matchup token");
  });

  it("rejects expired tokens", () => {
    const service = new MatchupTokenService("a-secret-long-enough", 1);
    const { token } = service.issue(claims, 1_000_000);
    expect(() => service.verify(token, 1_002_000)).toThrow(
      "Matchup token has expired",
    );
  });
});
