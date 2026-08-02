/**
 * Server-side stash for matchup metadata captured from `x-arena-matchup`.
 *
 * CopilotKit's AG-UI call happens inside the runtime route, so the browser
 * never sees that response header. ArenaHttpAgent's custom fetch records the
 * payload here keyed by CopilotKit `threadId`; the client polls
 * `GET /api/arena/matchup?threadId=…` after a run.
 *
 * In-process and single-instance only — fine for the flagship demo; a
 * multi-instance deploy would need shared storage.
 */
import type { ArenaMatchup } from "./protocol";

const byThread = new Map<string, ArenaMatchup>();

export const matchupCache = {
  set(threadId: string, matchup: ArenaMatchup): void {
    byThread.set(threadId, matchup);
  },

  get(threadId: string): ArenaMatchup | null {
    return byThread.get(threadId) ?? null;
  },

  clear(threadId: string): void {
    byThread.delete(threadId);
  },
};
