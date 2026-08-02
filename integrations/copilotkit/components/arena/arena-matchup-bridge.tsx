"use client";

import { useEffect, useRef } from "react";
import { useAgent } from "@copilotkit/react-core/v2";
import { parseArenaMatchup } from "@/lib/arena/protocol";
import { arenaStore, useArenaThread } from "@/lib/arena/store";

declare global {
  interface Window {
    /** Set by ArenaMatchupBridge when `onCustomEvent` receives `arena_matchup`. */
    __arenaMatchupViaCustom?: boolean;
    /** Set when the poll fallback hydrated a matchup. */
    __arenaMatchupViaPoll?: boolean;
  }
}

/**
 * Bridges CopilotKit's AG-UI proxy agent to the arena store:
 * 1. Try `onCustomEvent` for `arena_matchup` (surfaced per CopilotKit docs).
 * 2. Fall back to polling `GET /api/arena/matchup` after a run — the path that
 *    works when CUSTOM is dropped or the header never reaches the browser.
 */
export function ArenaMatchupBridge() {
  const { agent } = useAgent({ agentId: "arena" });
  const thread = useArenaThread();
  const polledForRun = useRef<string | null>(null);

  useEffect(() => {
    const threadId =
      (agent as { threadId?: string }).threadId ?? thread.threadId;
    if (threadId) arenaStore.setThreadId(threadId);
  }, [agent, thread.threadId]);

  useEffect(() => {
    if (!agent) return;

    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        const typed = event as { name?: string; value?: unknown };
        if (typed.name !== "arena_matchup") return;
        const matchup = parseArenaMatchup(typed.value);
        if (matchup) {
          // Diagnostic for e2e: did the CK runtime→frontend proxy forward CUSTOM?
          window.__arenaMatchupViaCustom = true;
          arenaStore.beginMatchup(matchup);
        }
      },
      onRunErrorEvent: ({ event }) => {
        arenaStore.noteRunError(event.message ?? "Arena run failed");
      },
      onRunFinishedEvent: () => {
        const threadId =
          (agent as { threadId?: string }).threadId ?? thread.threadId;
        if (!threadId) return;
        const runKey = `${threadId}:${Date.now()}`;
        if (polledForRun.current === runKey) return;
        polledForRun.current = runKey;
        void pollMatchup(threadId);
      },
    });

    return () => subscription.unsubscribe();
  }, [agent, thread.threadId]);

  return null;
}

async function pollMatchup(threadId: string): Promise<void> {
  // Brief retry: the runtime may finish streaming a tick before the agent's
  // fetch wrapper has written the cache entry.
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(
      `/api/arena/matchup?threadId=${encodeURIComponent(threadId)}`,
    );
    if (response.ok) {
      const payload: unknown = await response.json();
      const matchup = parseArenaMatchup(payload);
      if (matchup) {
        window.__arenaMatchupViaPoll = true;
        arenaStore.beginMatchup(matchup);
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
}
