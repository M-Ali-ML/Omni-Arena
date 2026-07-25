"use client";

import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { useEffect, useMemo } from "react";
import {
  getSessionId,
  parseArenaMatchup,
  parseSlotError,
  type ArenaSlot,
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
 * assistant-ui's AG-UI runtime drives a stock `@ag-ui/client` agent, and
 * OmniArena speaks AG-UI on the way *out* — but not on the way in: its chat
 * endpoint takes `{ prompt, sessionId, conversationId }`, not an AG-UI
 * `RunAgentInput`. Overriding `requestInit` is the whole adaptation; the
 * response stream is consumed byte-for-byte as the arena emits it.
 *
 * Client history is deliberately dropped: OmniArena rebuilds context
 * server-side from the *winning* response of each completed turn, keyed by
 * `conversationId`, and never trusts client-supplied history.
 */
export class ArenaHttpAgent extends HttpAgent {
  context: ArenaRequestContext = {
    arenaEnabled: true,
    conversationId: null,
    sessionId: "assistant-ui",
  };

  protected override requestInit(input: RunAgentInput): RequestInit {
    const prompt = lastUserText(input.messages);
    const { arenaEnabled, conversationId, sessionId } = this.context;
    return {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        // Honoured when OmniArena runs with ARENA_TRIGGER=manual; ignored when
        // it is configured to make every request a matchup.
        "x-arena": arenaEnabled ? "on" : "off",
      },
      body: JSON.stringify({
        prompt,
        sessionId,
        arena: arenaEnabled,
        ...(arenaEnabled && conversationId ? { conversationId } : {}),
      }),
    };
  }
}

function lastUserText(messages: RunAgentInput["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
}

/**
 * One agent per thread, plus the subscription that lifts the arena payloads
 * (`CUSTOM arena_matchup`, `CUSTOM slot_error`, slot order) out of the stream —
 * assistant-ui's runtime forwards `CUSTOM` events to its aggregator, which
 * ignores them, so a client that wants the vote token has to listen itself.
 */
export function useArenaAgent(threadId: string): ArenaHttpAgent {
  const thread = useArenaThread(threadId);
  const agent = useMemo(
    () => new ArenaHttpAgent({ url: ARENA_CHAT_ROUTE, threadId }),
    [threadId],
  );

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
    let matchupId: string | null = null;
    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        if (event.name === "arena_matchup") {
          const matchup = parseArenaMatchup(event.value);
          if (!matchup) return;
          matchupId = matchup.matchupId;
          arenaStore.beginMatchup(threadId, matchup);
          return;
        }
        if (event.name === "slot_error" && matchupId) {
          const failure = parseSlotError(event.value);
          if (failure) {
            arenaStore.noteSlotError(matchupId, failure.slot, failure.message);
          }
        }
      },
      onTextMessageStartEvent: ({ event }) => {
        // `slot` rides along on the wire (AG-UI events are passthrough-parsed),
        // but the message id is the tag that survives into assistant-ui.
        const slot = slotOf(event as { slot?: unknown }, event.messageId);
        if (matchupId && slot) arenaStore.noteSlotStart(matchupId, slot);
      },
      onRunErrorEvent: ({ event }) => {
        arenaStore.noteRunError(threadId, event.message ?? "Arena run failed");
      },
    });
    return () => subscription.unsubscribe();
  }, [agent, threadId]);

  return agent;
}

function slotOf(event: { slot?: unknown }, messageId: string): ArenaSlot | null {
  const candidate =
    typeof event.slot === "string" ? event.slot : messageId.slice(-1);
  return candidate === "A" || candidate === "B" ? candidate : null;
}
