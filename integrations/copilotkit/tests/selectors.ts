/**
 * Selector / data-testid contract for the CopilotKit arena e2e suite.
 *
 * The app builder implements these `data-testid` (and companion `data-*`)
 * attributes on the Next.js + CopilotKit UI. Reconciliation of this parallel
 * track touches **only this file** when the shipped markup diverges from the
 * draft names below — specs import every locator through these constants.
 *
 * Contract (every testid the specs use):
 *
 *   arena-controls              — chrome strip that hosts the arena toggle
 *   arena-toggle                — Arena mode on/off; `data-enabled="true|false"`
 *   arena-conversation          — active OmniArena conversation handle;
 *                                 `data-conversation="<uuid>|"` (empty when none)
 *   arena-message               — one turn / matchup root in the thread
 *                                 companions: `data-mode`, `data-turn-index`,
 *                                 `data-matchup-id`, `data-revealed` (optional)
 *   arena-slot-A / arena-slot-B — blind answer columns; `data-revealed="true|false"`
 *   arena-slot-label-A|B        — blind column chrome ("anonymous" / "Response A|B")
 *                                 before reveal; must not contain model display names
 *   arena-vote-bar              — five-way vote control row (absent when not votable)
 *   arena-vote-<vote>           — vote buttons: left | right | both_good | both_bad | skip
 *                                 (maps to OmniArena's POST /api/arena/vote `vote` enum)
 *   arena-reveal                — post-vote reveal strip naming both models
 *   arena-reveal-A / arena-reveal-B — per-slot model name badges after reveal
 *   arena-pick-badge            — marks the voted-for slot ("your pick" / equivalent)
 *   arena-can-continue          — visible when vote response had `continuable: true`
 *   arena-not-votable           — explanation replacing the vote bar on single rounds
 *   arena-run-error             — surface for in-band AG-UI RUN_ERROR / transport failure
 *
 * Vote enum (server): left | right | both_good | both_bad | skip.
 * "A better" ≡ left, "B better" ≡ right.
 */

export const SELECTORS = {
  CONTROLS: "arena-controls",
  ARENA_TOGGLE: "arena-toggle",
  CONVERSATION: "arena-conversation",
  MESSAGE: "arena-message",
  SLOT_COLUMN_A: "arena-slot-A",
  SLOT_COLUMN_B: "arena-slot-B",
  SLOT_LABEL_A: "arena-slot-label-A",
  SLOT_LABEL_B: "arena-slot-label-B",
  VOTE_BAR: "arena-vote-bar",
  REVEAL: "arena-reveal",
  REVEAL_BADGE_A: "arena-reveal-A",
  REVEAL_BADGE_B: "arena-reveal-B",
  PICK_BADGE: "arena-pick-badge",
  CONTINUATION_INDICATOR: "arena-can-continue",
  SINGLE_MODEL_NOTICE: "arena-not-votable",
  RUN_ERROR: "arena-run-error",
} as const;

export type ArenaVote = "left" | "right" | "both_good" | "both_bad" | "skip";

/** `data-testid` for a five-way vote button. */
export const VOTE_BUTTON = (vote: ArenaVote): string => `arena-vote-${vote}`;

export const REVEAL_BADGE = (slot: "A" | "B"): string =>
  slot === "A" ? SELECTORS.REVEAL_BADGE_A : SELECTORS.REVEAL_BADGE_B;

export const SLOT_COLUMN = (slot: "A" | "B"): string =>
  slot === "A" ? SELECTORS.SLOT_COLUMN_A : SELECTORS.SLOT_COLUMN_B;
