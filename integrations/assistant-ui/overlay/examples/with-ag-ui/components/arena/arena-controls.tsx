"use client";

import { Button } from "@/components/ui/button";
import { arenaStore, useActiveThreadId, useArenaThread } from "@/lib/arena/store";
import type { FC } from "react";

/**
 * The arena's status strip: whether the next turn is a blind matchup or a
 * single model, and whether it continues an OmniArena conversation.
 *
 * The toggle is only meaningful when OmniArena runs with
 * `ARENA_TRIGGER=manual`; with the default `always` trigger the server makes
 * every request a matchup regardless.
 */
export const ArenaControls: FC = () => {
  const threadId = useActiveThreadId();
  const thread = useArenaThread(threadId);

  return (
    <div
      data-testid="arena-controls"
      className="bg-background/80 flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm backdrop-blur"
    >
      <span className="font-medium">OmniArena × assistant-ui</span>
      <span className="text-muted-foreground text-xs">
        AG-UI runtime · <code>?protocol=ag-ui</code>
      </span>

      <Button
        type="button"
        size="sm"
        variant={thread.arenaEnabled ? "default" : "outline"}
        data-testid="arena-toggle"
        data-enabled={thread.arenaEnabled ? "true" : "false"}
        onClick={() => arenaStore.setArenaEnabled(threadId, !thread.arenaEnabled)}
      >
        {thread.arenaEnabled ? "Arena mode: on" : "Arena mode: off"}
      </Button>

      <span
        data-testid="arena-conversation"
        data-conversation={thread.conversationId ?? ""}
        className="text-muted-foreground text-xs"
      >
        {thread.conversationId
          ? `continuing conversation ${thread.conversationId.slice(0, 8)}…`
          : "new conversation on next message"}
      </span>

      {thread.conversationId && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="arena-reset"
          onClick={() => arenaStore.resetThread(threadId)}
        >
          Start fresh
        </Button>
      )}

      {thread.runError && (
        <span data-testid="arena-run-error" className="text-destructive text-xs">
          {thread.runError}
        </span>
      )}
    </div>
  );
};
