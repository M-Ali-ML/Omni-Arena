"use client";

import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { useEffect, useMemo } from "react";
import {
  getSessionId,
  MATCHUP_HEADER,
  parseMatchupHeader,
} from "./protocol";
import { arenaStore, useArenaThread } from "./store";

/** Same-origin Next route; it forwards to OmniArena's `?protocol=ag-ui` stream. */
const ARENA_CHAT_ROUTE = "/api/arena/chat";

type ArenaRequestContext = {
  arenaEnabled: boolean;
  conversationId: string | null;
  sessionId: string;
};

/**
 * Thin wrapper around stock `HttpAgent`. OmniArena already accepts a canonical
 * `RunAgentInput`; what `useAgUiRuntime` cannot do is put arena session /
 * continuation / trigger into `forwardedProps` (it only fills those from its
 * own model context) or attach `x-arena`. Overriding `requestInit` is the
 * whole remaining adaptation — the body stays AG-UI-shaped.
 *
 * The vote token is read from the `x-arena-matchup` response header via the
 * custom `fetch` below, not from a `CUSTOM` subscriber: assistant-ui's
 * aggregator drops `CUSTOM` events, so the header is the path that works with
 * the stock runtime.
 */
export class ArenaHttpAgent extends HttpAgent {
  context: ArenaRequestContext = {
    arenaEnabled: true,
    conversationId: null,
    sessionId: "assistant-ui",
  };

  protected override requestInit(input: RunAgentInput): RequestInit {
    const { arenaEnabled, conversationId, sessionId } = this.context;
    const init = super.requestInit({
      ...input,
      forwardedProps: {
        ...(input.forwardedProps as Record<string, unknown> | undefined),
        sessionId,
        arena: arenaEnabled,
        ...(arenaEnabled && conversationId ? { conversationId } : {}),
      },
    });
    const headers = new Headers(init.headers);
    headers.set("x-arena", arenaEnabled ? "on" : "off");
    return { ...init, headers };
  }
}

/**
 * One agent per thread. Matchup metadata lands through the response header;
 * run errors still need a tiny subscriber because the controls strip sits
 * outside the message tree.
 */
export function useArenaAgent(threadId: string): ArenaHttpAgent {
  const thread = useArenaThread(threadId);
  const agent = useMemo(() => {
    const fetchWithMatchup: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const matchup = parseMatchupHeader(response.headers.get(MATCHUP_HEADER));
      if (matchup) arenaStore.beginMatchup(threadId, matchup);
      return response;
    };
    return new ArenaHttpAgent({
      url: ARENA_CHAT_ROUTE,
      threadId,
      fetch: fetchWithMatchup,
    });
  }, [threadId]);

  // Read during render so the very next run picks up the current toggle and
  // conversation handle without waiting for an effect to flush.
  agent.context = {
    arenaEnabled: thread.arenaEnabled,
    conversationId: thread.conversationId,
    sessionId: getSessionId(),
  };

  useEffect(() => {
    arenaStore.setActiveThread(threadId);
  }, [threadId]);

  useEffect(() => {
    const subscription = agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        arenaStore.noteRunError(threadId, event.message ?? "Arena run failed");
      },
    });
    return () => subscription.unsubscribe();
  }, [agent, threadId]);

  return agent;
}
