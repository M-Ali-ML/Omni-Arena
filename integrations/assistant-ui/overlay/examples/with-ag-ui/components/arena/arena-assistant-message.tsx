"use client";

import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { matchupIdFromMessageId, type ArenaSlot } from "@/lib/arena/protocol";
import { useMatchup, type MatchupState } from "@/lib/arena/store";
import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import type { FC } from "react";
import { ArenaVoteBar } from "./arena-vote-bar";

/**
 * The arena's replacement for upstream's `AssistantMessage`.
 *
 * OmniArena streams two anonymous answers as two concurrent AG-UI text
 * messages; assistant-ui's AG-UI runtime folds them into *one* assistant
 * message with one text part per slot. So the blind pair is
 * `MessagePrimitive.PartByIndex index={0}` and `index={1}` — assistant-ui's own
 * part primitives, rendered with upstream's `MarkdownText`, just laid out in
 * two columns instead of stacked.
 */
export const ArenaAssistantMessage: FC = () => {
  const messageId = useAuiState((s) => s.message.id);
  const partCount = useAuiState((s) => s.message.parts.length);
  const isRunning = useAuiState(
    (s) => (s.message.status?.type ?? "complete") === "running",
  );
  const matchupId = matchupIdFromMessageId(messageId);
  const matchup = useMatchup(matchupId);

  const slots = matchup?.slots ?? (["A", "B"] as ArenaSlot[]);
  const singleColumn = slots.length === 1;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      data-testid="arena-message"
      data-matchup-id={matchupId ?? ""}
      data-turn-index={
        matchup?.turnIndex === undefined ? "" : String(matchup.turnIndex)
      }
      data-mode={matchup?.mode ?? ""}
      className="fade-in slide-in-from-bottom-1 animate-in relative w-full duration-150"
    >
      <div
        className={
          singleColumn
            ? "grid grid-cols-1 gap-4"
            : "grid grid-cols-1 gap-4 @xl:grid-cols-2"
        }
      >
        {slots.map((slot, index) => (
          <ArenaColumn
            key={slot}
            slot={slot}
            index={index}
            hasPart={index < partCount}
            isRunning={isRunning}
            matchup={matchup}
          />
        ))}
      </div>

      <MessagePrimitive.Error>
        <div className="border-destructive bg-destructive/10 text-destructive mt-3 rounded-md border p-3 text-sm">
          The arena run failed.
        </div>
      </MessagePrimitive.Error>

      <ArenaVoteBar matchupId={matchupId} isRunning={isRunning} />
    </MessagePrimitive.Root>
  );
};

const SLOT_LABEL: Record<ArenaSlot, string> = { A: "Response A", B: "Response B" };

const ArenaColumn: FC<{
  slot: ArenaSlot;
  index: number;
  hasPart: boolean;
  isRunning: boolean;
  matchup: MatchupState | null;
}> = ({ slot, index, hasPart, isRunning, matchup }) => {
  // Column order follows TEXT_MESSAGE_START order, which is also the order
  // assistant-ui appends the text parts — so column i renders part i.
  const streamedSlot = matchup?.slotOrder[index] ?? slot;
  const reveal = matchup?.reveal?.[streamedSlot];
  const error = matchup?.errors?.[streamedSlot];
  const won =
    matchup?.vote === "left"
      ? streamedSlot === "A"
      : matchup?.vote === "right"
        ? streamedSlot === "B"
        : false;

  return (
    <section
      data-testid={`arena-slot-${streamedSlot}`}
      data-revealed={reveal ? "true" : "false"}
      className="bg-card flex min-w-0 flex-col rounded-xl border p-4"
    >
      <header className="mb-2 flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
        <span className="text-muted-foreground">
          {matchup?.mode === "single" ? "Single model" : SLOT_LABEL[streamedSlot]}
        </span>
        {reveal ? (
          <span
            data-testid={`arena-reveal-${streamedSlot}`}
            className="bg-primary/10 text-primary rounded-full px-2 py-0.5 normal-case"
          >
            {reveal.displayName}
          </span>
        ) : (
          <span className="text-muted-foreground/60 normal-case">anonymous</span>
        )}
        {won && (
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-600 normal-case dark:text-emerald-400">
            your pick
          </span>
        )}
      </header>

      <div className="text-foreground min-w-0 leading-relaxed wrap-break-word">
        {hasPart ? (
          <MessagePrimitive.PartByIndex
            index={index}
            components={{ Text: MarkdownText }}
          />
        ) : (
          <span className="text-muted-foreground animate-pulse text-sm">
            {isRunning ? "waiting for tokens…" : "no response"}
          </span>
        )}
      </div>

      {error && (
        <p
          data-testid={`arena-slot-error-${streamedSlot}`}
          className="text-destructive mt-2 text-sm"
        >
          {error}
        </p>
      )}
    </section>
  );
};
