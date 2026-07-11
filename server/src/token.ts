import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

export interface MatchupTokenClaims {
  matchupId: string;
  slotAModelId: string;
  slotBModelId: string;
  sessionId: string | null;
  exp: number;
}

export class MatchupTokenService {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds = 15 * 60,
  ) {
    if (secret.length < 16) {
      throw new Error("MATCHUP_TOKEN_SECRET must be at least 16 characters");
    }
  }

  issue(
    claims: Omit<MatchupTokenClaims, "exp">,
    now = Date.now(),
  ): { token: string; hash: string } {
    const payload = Buffer.from(
      JSON.stringify({
        ...claims,
        exp: Math.floor(now / 1000) + this.ttlSeconds,
      }),
    ).toString("base64url");
    const signature = this.sign(payload);
    const token = `${payload}.${signature}`;
    return { token, hash: this.hash(token) };
  }

  verify(token: string, now = Date.now()): MatchupTokenClaims {
    const [payload, suppliedSignature, extra] = token.split(".");
    if (!payload || !suppliedSignature || extra) {
      throw new Error("Invalid matchup token");
    }

    const expectedSignature = this.sign(payload);
    const supplied = Buffer.from(suppliedSignature, "base64url");
    const expected = Buffer.from(expectedSignature, "base64url");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new Error("Invalid matchup token");
    }

    let claims: MatchupTokenClaims;
    try {
      claims = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as MatchupTokenClaims;
    } catch {
      throw new Error("Invalid matchup token");
    }

    if (
      typeof claims.matchupId !== "string" ||
      typeof claims.slotAModelId !== "string" ||
      typeof claims.slotBModelId !== "string" ||
      typeof claims.exp !== "number"
    ) {
      throw new Error("Invalid matchup token");
    }
    if (claims.exp <= Math.floor(now / 1000)) {
      throw new Error("Matchup token has expired");
    }
    return claims;
  }

  matchesHash(token: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hash(token), "hex");
    const expected = Buffer.from(expectedHash, "hex");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url");
  }

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
