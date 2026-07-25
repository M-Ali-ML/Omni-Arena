import {
  parseArenaReveal,
  type ArenaReveal,
  type ArenaVote,
} from "./protocol.js";

export interface SubmitArenaVoteInput {
  matchupId: string;
  matchupToken: string;
  vote: ArenaVote;
  /**
   * Origin (or path prefix) the arena API is served from. Defaults to "" so the
   * request hits the same-origin `/api/arena/vote` route; pass an absolute
   * origin when calling from a server route or another process.
   */
  baseUrl?: string;
  signal?: AbortSignal;
}

/**
 * `POST /api/arena/vote`, plain and React-free: a host app that votes from its
 * own proxy route calls this directly. Rejects with the server's message
 * (`Vote already recorded`, `Invalid matchup token`, …) so a caller can surface
 * it verbatim, and resolves with the reveal on success.
 */
export async function submitArenaVote(
  input: SubmitArenaVoteInput,
): Promise<ArenaReveal> {
  const { matchupId, matchupToken, vote, baseUrl = "", signal } = input;
  const response = await fetch(`${baseUrl}/api/arena/vote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ matchupId, matchupToken, vote }),
    ...(signal ? { signal } : {}),
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  const reveal = parseArenaReveal({ ...payload, vote });
  if (!response.ok || !reveal) {
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : `Vote failed (${response.status})`,
    );
  }
  return reveal;
}
