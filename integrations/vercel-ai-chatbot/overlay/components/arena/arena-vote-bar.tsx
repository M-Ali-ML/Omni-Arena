"use client";

import { Button } from "@/components/ui/button";
import {
  ARENA_VOTE_OPTIONS,
  type ArenaMeta,
  type ArenaVote,
} from "@/lib/arena/protocol";
import { type ArenaVoteState, useArena } from "./arena-provider";

export function ArenaVoteBar({
  chatId,
  messageId,
  meta,
  state,
  isStreaming,
}: {
  chatId: string;
  messageId: string;
  meta: ArenaMeta;
  state: ArenaVoteState;
  isStreaming: boolean;
}) {
  const { castVote } = useArena();
  const isRecorded = state.status === "recorded";
  const disabled = isStreaming || isRecorded || state.status === "pending";

  const onVote = (vote: ArenaVote): void => {
    void castVote({ chatId, messageId, meta, vote });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2" data-testid="arena-votes">
        {ARENA_VOTE_OPTIONS.map((option) => (
          <Button
            data-testid={`arena-vote-${option.value}`}
            disabled={disabled}
            key={option.value}
            onClick={() => onVote(option.value)}
            size="sm"
            variant={
              isRecorded && state.vote === option.value ? "default" : "outline"
            }
          >
            {option.label}
          </Button>
        ))}
        {isStreaming && (
          <span className="text-[11px] text-muted-foreground">
            vote once both answers finish
          </span>
        )}
      </div>

      {state.status === "error" && (
        <p className="text-[12px] text-destructive" data-testid="arena-vote-error">
          {state.error}
        </p>
      )}
    </div>
  );
}
