"use client";

import { useEffect, useRef } from "react";
import { useAgent } from "@copilotkit/react-core/v2";
import { rehydrateArenaThread } from "@/lib/arena/history";
import { parseArenaMatchup } from "@/lib/arena/protocol";
import { arenaStore, useArenaThread } from "@/lib/arena/store";

declare global {
  interface Window {
    /** Set by ArenaMatchupBridge when `onCustomEvent` receives `arena_matchup`. */
    __arenaMatchupViaCustom?: boolean;
    /** Set when the poll fallback hydrated a matchup. */
    __arenaMatchupViaPoll?: boolean;
    /** Set when conversation GET rehydration restored the thread. */
    __arenaRehydrated?: boolean;
  }
}

/**
 * Bridges CopilotKit's AG-UI proxy agent to the arena store:
 * 1. On mount, rehydrate from a persisted conversationId via conversation GET.
 * 2. Try `onCustomEvent` for `arena_matchup` (surfaced per CopilotKit docs).
 * 3. Fall back to polling `GET /api/arena/matchup` after a run — the path that
 *    works when CUSTOM is dropped or the header never reaches the browser.
 */
export function ArenaMatchupBridge() {
  const { agent } = useAgent({ agentId: "arena" });
  const thread = useArenaThread();
  const polledForRun = useRef<string | null>(null);
  const rehydrated = useRef(false);

  useEffect(() => {
    const threadId =
      (agent as { threadId?: string }).threadId ?? thread.threadId;
    if (threadId) arenaStore.setThreadId(threadId);
  }, [agent, thread.threadId]);

  useEffect(() => {
    if (!agent || rehydrated.current) return;
    rehydrated.current = true;
    void rehydrateArenaThread(agent).then((ok) => {
      if (ok) window.__arenaRehydrated = true;
    });
  }, [agent]);

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
          arenaStore.setMatchupStreaming(matchup.matchupId, true);
        }
      },
      onRunErrorEvent: ({ event }) => {
        arenaStore.noteRunError(event.message ?? "Arena run failed");
      },
      onRunFinishedEvent: () => {
        // CopilotKit's assistant-message `isRunning` can remain true after paced
        // dual-slot runs; unlock the vote bar from the agent lifecycle instead.
        arenaStore.clearStreaming();
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
