"use client";

import { arenaStore, useArenaThread } from "@/lib/arena/store";

/**
 * Status strip: arena mode toggle + continuation handle. Meaningful under
 * `ARENA_TRIGGER=manual` (what the harness uses).
 */
export function ArenaControls() {
  const thread = useArenaThread();

  return (
    <div data-testid="arena-controls" className="arena-controls">
      <span className="arena-brand">OmniArena × CopilotKit</span>
      <span className="arena-muted">
        AG-UI · <code>?protocol=ag-ui</code>
      </span>

      <button
        type="button"
        className={
          thread.arenaEnabled ? "arena-toggle on" : "arena-toggle off"
        }
        data-testid="arena-toggle"
        data-enabled={thread.arenaEnabled ? "true" : "false"}
        onClick={() => arenaStore.setArenaEnabled(!thread.arenaEnabled)}
      >
        {thread.arenaEnabled ? "Arena mode: on" : "Arena mode: off"}
      </button>

      <span
        data-testid="arena-conversation"
        data-conversation={thread.conversationId ?? ""}
        className="arena-muted"
      >
        {thread.conversationId
          ? `continuing conversation ${thread.conversationId.slice(0, 8)}…`
          : "new conversation on next message"}
      </span>

      {thread.conversationId && (
        <button
          type="button"
          className="arena-reset"
          data-testid="arena-reset"
          onClick={() => arenaStore.resetConversation()}
        >
          Start fresh
        </button>
      )}

      {thread.runError && (
        <span data-testid="arena-run-error" className="arena-error">
          {thread.runError}
        </span>
      )}
    </div>
  );
}
