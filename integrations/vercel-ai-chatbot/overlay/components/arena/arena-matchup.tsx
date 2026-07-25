"use client";

import { useEffect } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  type ArenaMatchupView,
  type ArenaSlot,
  isDecisiveVote,
} from "@/lib/arena/protocol";
import { cn } from "@/lib/utils";
import { useArena } from "./arena-provider";
import { ArenaVoteBar } from "./arena-vote-bar";

function SlotColumn({
  slot,
  text,
  isStreaming,
  errorMessage,
  revealedName,
  isWinner,
}: {
  slot: ArenaSlot;
  text: string;
  isStreaming: boolean;
  errorMessage?: string;
  revealedName?: string;
  isWinner: boolean;
}) {
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-2xl border bg-card/20 p-3.5",
        isWinner ? "border-primary/60" : "border-border/30",
      )}
      data-testid={`arena-slot-${slot.toLowerCase()}`}
    >
      <header className="flex items-center justify-between gap-2">
        <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
          Model {slot}
        </span>
        {revealedName && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px]",
              isWinner
                ? "bg-primary/15 text-primary"
                : "bg-muted/60 text-muted-foreground",
            )}
            data-testid={`arena-reveal-${slot.toLowerCase()}`}
          >
            {revealedName}
            {isWinner ? " · winner" : ""}
          </span>
        )}
      </header>

      <div className="min-w-0 text-[13px] leading-[1.65]">
        {text ? (
          <MessageResponse>{text}</MessageResponse>
        ) : (
          isStreaming && (
            <Shimmer as="span" duration={1}>
              Waiting…
            </Shimmer>
          )
        )}
      </div>

      {errorMessage && (
        <p
          className="text-[12px] text-destructive"
          data-testid={`arena-error-${slot.toLowerCase()}`}
        >
          {errorMessage}
        </p>
      )}
    </article>
  );
}

/**
 * One blind matchup rendered inside the app's own message list: two anonymous
 * columns streaming concurrently, the vote controls, and the post-vote reveal.
 */
export function ArenaMatchup({
  chatId,
  messageId,
  matchup,
  isStreaming,
}: {
  chatId: string;
  messageId: string;
  matchup: ArenaMatchupView;
  isStreaming: boolean;
}) {
  const arena = useArena();
  const { hydrate, voteState } = arena;
  const { meta, reveal: persistedReveal } = matchup;

  // A matchup replayed from the database already knows its outcome; feed it back
  // so the reveal renders and a decisive round stays continuable after reload.
  useEffect(() => {
    hydrate(chatId, meta, persistedReveal);
  }, [chatId, hydrate, meta, persistedReveal]);

  const state = voteState(meta.matchupId);
  const reveal = state.reveal ?? persistedReveal;
  const isSingle = matchup.mode !== "matchup";
  const errorFor = (slot: ArenaSlot): string | undefined =>
    matchup.errors.find((error) => error.slot === slot)?.message;

  return (
    <section className="flex flex-col gap-3" data-testid="arena-matchup">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span
          className="rounded-full border border-border/40 px-2 py-0.5"
          data-testid="arena-mode"
        >
          {isSingle ? "Single model" : "Blind matchup"}
        </span>
        {/* A round OmniArena persisted nothing for has no turn to number. */}
        {meta.turnIndex !== undefined && (
          <span data-testid="arena-turn">turn {meta.turnIndex + 1}</span>
        )}
        {isStreaming && <span>· streaming</span>}
      </div>

      <div
        className={cn(
          "grid gap-3",
          isSingle ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2",
        )}
      >
        <SlotColumn
          errorMessage={errorFor("A")}
          isStreaming={isStreaming}
          isWinner={reveal?.vote === "left"}
          revealedName={reveal?.models.A.displayName}
          slot="A"
          text={matchup.slotA}
        />
        {!isSingle && (
          <SlotColumn
            errorMessage={errorFor("B")}
            isStreaming={isStreaming && !matchup.slotBDone}
            isWinner={reveal?.vote === "right"}
            revealedName={reveal?.models.B.displayName}
            slot="B"
            text={matchup.slotB}
          />
        )}
      </div>

      {matchup.votable ? (
        <ArenaVoteBar
          chatId={chatId}
          isStreaming={isStreaming}
          messageId={messageId}
          meta={meta}
          state={state}
        />
      ) : (
        <p className="text-[12px] text-muted-foreground" data-testid="arena-no-vote">
          {isSingle
            ? "This deployment served a single model for this turn, so there is nothing to vote on."
            : "This round did not expose a vote token, so voting is unavailable."}
        </p>
      )}

      {reveal && (
        <p
          className="text-[12px] text-muted-foreground"
          data-testid="arena-continuation"
        >
          {isDecisiveVote(reveal.vote)
            ? "Your next message continues this conversation from the winning answer."
            : "No single winner, so your next message starts a fresh arena conversation."}
        </p>
      )}
    </section>
  );
}
