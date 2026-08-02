"use client";

import {
  CopilotChatAssistantMessage,
  type CopilotChatAssistantMessageProps,
} from "@copilotkit/react-core/v2";
import { parseSlotMessageId, type ArenaSlot } from "@/lib/arena/protocol";
import { useMatchup, type MatchupState } from "@/lib/arena/store";
import { ArenaVoteBar } from "./arena-vote-bar";

const SLOT_LABEL: Record<ArenaSlot, string> = {
  A: "Response A",
  B: "Response B",
};

/**
 * Groups OmniArena's two concurrent AG-UI text messages (`<matchupId>:A|B`)
 * into blind side-by-side columns. Slot B is suppressed so A renders both;
 * non-arena messages fall through to the stock assistant message.
 */
export function ArenaAssistantMessage(props: CopilotChatAssistantMessageProps) {
  const { message, messages, isRunning } = props;
  const parsed = parseSlotMessageId(message.id);
  const matchupId = parsed?.matchupId ?? null;
  const matchup = useMatchup(matchupId);

  if (!parsed) {
    return <CopilotChatAssistantMessage {...props} />;
  }

  // Column B is painted by A's render so we do not stack two full bubbles.
  if (parsed.slot === "B") return null;

  const siblingB = messages?.find(
    (entry) => entry.id === `${parsed.matchupId}:B`,
  );
  const slots =
    matchup?.slots ??
    (siblingB ? (["A", "B"] as ArenaSlot[]) : (["A"] as ArenaSlot[]));
  const singleColumn = slots.length === 1;

  const contentFor = (slot: ArenaSlot): string => {
    const id = `${parsed.matchupId}:${slot}`;
    const entry =
      messages?.find((m) => m.id === id) ?? (slot === "A" ? message : undefined);
    if (!entry) return "";
    const content = (entry as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  };

  return (
    <div
      data-testid="arena-message"
      data-matchup-id={parsed.matchupId}
      data-turn-index={
        matchup?.turnIndex === undefined ? "" : String(matchup.turnIndex)
      }
      data-mode={matchup?.mode ?? ""}
      className="arena-message"
    >
      <div
        className={
          singleColumn ? "arena-columns arena-columns-single" : "arena-columns"
        }
      >
        {slots.map((slot) => (
          <ArenaColumn
            key={slot}
            slot={slot}
            content={contentFor(slot)}
            isRunning={Boolean(isRunning)}
            matchup={matchup}
          />
        ))}
      </div>
      <ArenaVoteBar
        matchupId={parsed.matchupId}
        isRunning={Boolean(isRunning)}
      />
    </div>
  );
}

function ArenaColumn({
  slot,
  content,
  isRunning,
  matchup,
}: {
  slot: ArenaSlot;
  content: string;
  isRunning: boolean;
  matchup: MatchupState | null;
}) {
  const reveal = matchup?.reveal?.[slot];
  const won =
    matchup?.vote === "left"
      ? slot === "A"
      : matchup?.vote === "right"
        ? slot === "B"
        : false;

  return (
    <section
      data-testid={`arena-slot-${slot}`}
      data-revealed={reveal ? "true" : "false"}
      className="arena-column"
    >
      <header className="arena-column-header">
        {/* Blind chrome only — model names live on arena-reveal-* after vote. */}
        <span data-testid={`arena-slot-label-${slot}`}>
          {matchup?.mode === "single" ? "Single model" : SLOT_LABEL[slot]}
          {!reveal && <span className="arena-anonymous"> anonymous</span>}
        </span>
        {reveal ? (
          <span
            data-testid={`arena-reveal-${slot}`}
            className="arena-badge arena-badge-model"
          >
            {reveal.displayName}
          </span>
        ) : null}
        {won && (
          <span
            data-testid="arena-pick-badge"
            className="arena-badge arena-badge-pick"
          >
            your pick
          </span>
        )}
      </header>
      <div className="arena-column-body">
        {content ? (
          <pre className="arena-content">{content}</pre>
        ) : (
          <span className="arena-waiting">
            {isRunning ? "waiting for tokens…" : "no response"}
          </span>
        )}
      </div>
    </section>
  );
}
