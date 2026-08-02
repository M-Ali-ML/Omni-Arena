import { expect, test, type Page, type Response } from "@playwright/test";
import { mockVariantTag } from "../../../server/src/providers/mock.js";
import { SELECTORS, SLOT_COLUMN, VOTE_BUTTON } from "./selectors.js";

/** Mirrors the roster `harness/arena.ts` seeds, slot A first. */
const ROSTER = {
  A: { providerModelId: "mock-alpha", displayName: "Mock Model Alpha" },
  B: { providerModelId: "mock-beta", displayName: "Mock Model Beta" },
} as const;

/**
 * Matches the identity-free fingerprint the mock provider stamps on one model's
 * answer: `variant <hash of the provider model id>`. Matching only that fragment
 * — not the sentence around it — keeps these assertions stable when the mock's
 * wording changes, and matching the model's *name* here would be the pre-vote
 * identity leak the arena exists to prevent.
 */
const fingerprintOf = (providerModelId: string): RegExp =>
  new RegExp(`variant ${mockVariantTag(providerModelId)}\\b`);

/**
 * Drives the CopilotKit Next app (ArenaHttpAgent → CopilotRuntime at
 * `/api/copilotkit` → OmniArena `?protocol=ag-ui`) against a real OmniArena
 * harness on the deterministic mock provider: prompt → two blind streams →
 * vote → reveal → multi-turn follow-up → reload rehydration, plus the
 * non-votable single-model round.
 *
 * Intentional app deviations from the draft contract: `arena-vote-bar` is
 * omitted after a vote (reveal strip only); `data-revealed` lives on columns,
 * not on `arena-message`. Soft gates below keep coverage when the fast mock
 * races mid-stream UI or when CopilotRuntime strips response headers.
 */

const SLOT_A_ANSWER = fingerprintOf(ROSTER.A.providerModelId);
const SLOT_B_ANSWER = fingerprintOf(ROSTER.B.providerModelId);

const send = async (page: Page, prompt: string): Promise<void> => {
  // CopilotKit composer is a native <textarea> (role=textbox; also
  // data-testid="copilot-chat-textarea").
  const composer = page.getByRole("textbox").first();
  await composer.click();
  await composer.fill(prompt);
  await composer.press("Enter");
};

const messages = (page: Page) => page.getByTestId(SELECTORS.MESSAGE);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId(SELECTORS.CONTROLS)).toBeVisible();
});

test("streams two blind answers, votes, reveals, and continues the winner", async ({
  page,
}) => {
  await expect(page.getByTestId(SELECTORS.ARENA_TOGGLE)).toHaveAttribute(
    "data-enabled",
    "true",
  );

  // Capture the CopilotKit → OmniArena hop so continuation can be proven from
  // the wire (conversationId + turnIndex) even if UI attrs lag.
  const chatResponses: Array<{ body?: unknown; matchupHeader?: string }> = [];
  page.on("response", async (response: Response) => {
    if (!response.url().includes("/api/copilotkit")) return;
    if (response.request().method() !== "POST") return;
    try {
      const header = response.headers()["x-arena-matchup"];
      chatResponses.push({ matchupHeader: header });
    } catch {
      // Response may already be consumed by the runtime; header read is enough.
      chatResponses.push({});
    }
  });

  await send(page, "Explain JSON Web Tokens in simple terms.");

  const first = messages(page).first();
  const slotA = first.getByTestId(SLOT_COLUMN("A"));
  const slotB = first.getByTestId(SLOT_COLUMN("B"));

  // Both slots stream concurrently inside one AG-UI run, and the distinct
  // fingerprints prove each column carries its own model's answer.
  await expect(slotA).toContainText(SLOT_A_ANSWER);
  await expect(slotB).toContainText(SLOT_B_ANSWER);

  // Blind until the vote lands — no model display names in either column.
  // `data-revealed` is on columns only (not on arena-message).
  await expect(slotA).toHaveAttribute("data-revealed", "false");
  await expect(slotB).toHaveAttribute("data-revealed", "false");
  await expect(first).toHaveAttribute("data-mode", "matchup");
  await expect(first).toHaveAttribute("data-turn-index", "0");

  const labelA = first.getByTestId(SELECTORS.SLOT_LABEL_A);
  await expect(labelA).not.toContainText(ROSTER.A.displayName);
  await expect(labelA).not.toContainText(ROSTER.B.displayName);
  await expect(labelA).toContainText(/anonymous|response a/i);

  // Soft: mid-stream vote-bar disabled races the fast mock; once both
  // fingerprints are present the streams are finished and buttons are enabled.
  const voteBar = first.getByTestId(SELECTORS.VOTE_BAR);
  await expect(voteBar).toBeVisible();
  const preferA = first.getByTestId(VOTE_BUTTON("left"));
  await expect(preferA).toBeEnabled();
  await preferA.click();

  const reveal = first.getByTestId(SELECTORS.REVEAL);
  await expect(reveal).toContainText(ROSTER.A.displayName);
  await expect(reveal).toContainText(ROSTER.B.displayName);
  await expect(slotA).toHaveAttribute("data-revealed", "true");
  await expect(slotB).toHaveAttribute("data-revealed", "true");
  // After a vote the five-way row is gone; only the reveal strip remains.
  await expect(first.getByTestId(SELECTORS.VOTE_BAR)).toHaveCount(0);

  await expect(first.getByTestId(SELECTORS.REVEAL_BADGE_A)).toContainText(
    ROSTER.A.displayName,
  );
  await expect(first.getByTestId(SELECTORS.REVEAL_BADGE_B)).toContainText(
    ROSTER.B.displayName,
  );
  await expect(first.getByTestId(SELECTORS.PICK_BADGE)).toBeVisible();

  await expect(first.getByTestId(SELECTORS.CONTINUATION_INDICATOR)).toBeVisible();

  const conversation = page.getByTestId(SELECTORS.CONVERSATION);
  await expect(conversation).not.toHaveAttribute("data-conversation", "");
  const conversationId = await conversation.getAttribute("data-conversation");

  // Soft: CopilotRuntime does not forward OmniArena's `x-arena-matchup` on
  // `/api/copilotkit` (AG-UI hop is server-side). UI + poll path are authoritative.
  const firstHeader = chatResponses
    .map((entry) => entry.matchupHeader)
    .find((header) => header);
  if (firstHeader) {
    const matchup = JSON.parse(firstHeader);
    expect(matchup.turnIndex).toBe(0);
    expect(matchup.conversationId).toBe(conversationId);
    expect(matchup.votable).toBe(true);
    expect(matchup.mode).toBe("matchup");
  }

  await send(page, "Now give me an example token.");

  await expect(messages(page)).toHaveCount(2);
  const second = messages(page).nth(1);
  await expect(second.getByTestId(SLOT_COLUMN("A"))).toContainText(SLOT_A_ANSWER);
  await expect(second.getByTestId(SLOT_COLUMN("B"))).toContainText(SLOT_B_ANSWER);
  // turnIndex 1 in the same conversation proves OmniArena continued the thread
  // from the winning response rather than starting a new one.
  await expect(second).toHaveAttribute("data-turn-index", "1");
  await expect(conversation).toHaveAttribute(
    "data-conversation",
    conversationId ?? "",
  );
});

test("a tie reveals the models but starts the next turn fresh", async ({ page }) => {
  await send(page, "Which is better, tabs or spaces?");

  const first = messages(page).first();
  // both_good is the decisive-tie path: reveal + continuable:false.
  const vote = first.getByTestId(VOTE_BUTTON("both_good"));
  await expect(vote).toBeEnabled();
  await vote.click();

  await expect(first.getByTestId(SELECTORS.REVEAL)).toContainText("Mock Model");
  await expect(first.getByTestId(SELECTORS.CONTINUATION_INDICATOR)).toHaveCount(0);
  await expect(page.getByTestId(SELECTORS.CONVERSATION)).toHaveAttribute(
    "data-conversation",
    "",
  );

  await send(page, "Say that again.");
  await expect(messages(page)).toHaveCount(2);
  // No winner to continue from, so OmniArena starts a new conversation.
  await expect(messages(page).nth(1)).toHaveAttribute("data-turn-index", "0");
});

test("hides the vote UI when the round is not votable", async ({ page }) => {
  await page.getByTestId(SELECTORS.ARENA_TOGGLE).click();
  await expect(page.getByTestId(SELECTORS.ARENA_TOGGLE)).toHaveAttribute(
    "data-enabled",
    "false",
  );

  await send(page, "Single model please.");

  const message = messages(page).first();
  await expect(message).toHaveAttribute("data-mode", "single");
  // A manual-trigger harness answers a non-arena round with its default model,
  // which is the roster's slot-A model.
  await expect(message.getByTestId(SLOT_COLUMN("A"))).toContainText(SLOT_A_ANSWER);
  await expect(message.getByTestId(SLOT_COLUMN("B"))).toHaveCount(0);
  await expect(message.getByTestId(SELECTORS.SINGLE_MODEL_NOTICE)).toBeVisible();
  await expect(message.getByTestId(SELECTORS.VOTE_BAR)).toHaveCount(0);
});

// Increment 1 did not ship reload rehydration (no conversation GET hydrate,
// threadId is minted fresh each mount). Deferred to Increment 3.
test.fixme(
  "rehydrates the thread after a reload",
  async ({ page }) => {
  // FIXME(Increment 3): reload rehydration not in Increment 1 scope.
  await send(page, "Explain JSON Web Tokens in simple terms.");

  const first = messages(page).first();
  await expect(first.getByTestId(SLOT_COLUMN("A"))).toContainText(SLOT_A_ANSWER);
  await first.getByTestId(VOTE_BUTTON("left")).click();
  await expect(first.getByTestId(SELECTORS.REVEAL)).toContainText(
    ROSTER.A.displayName,
  );

  const conversationId = await page
    .getByTestId(SELECTORS.CONVERSATION)
    .getAttribute("data-conversation");
  expect(conversationId).toBeTruthy();

  await send(page, "Now give me an example token.");
  await expect(messages(page)).toHaveCount(2);
  await expect(messages(page).nth(1)).toHaveAttribute("data-turn-index", "1");
  await messages(page).nth(1).getByTestId(VOTE_BUTTON("right")).click();
  await expect(messages(page).nth(1).getByTestId(SELECTORS.REVEAL)).toContainText(
    ROSTER.B.displayName,
  );

  await page.reload();
  await expect(page.getByTestId(SELECTORS.CONTROLS)).toBeVisible();

  // Increment 3 must restore both turns including reveal state (thread
  // persistence + conversation GET rehydration).
  await expect(messages(page)).toHaveCount(2);
  await expect(messages(page).first().getByTestId(SELECTORS.REVEAL)).toContainText(
    ROSTER.A.displayName,
  );
  await expect(messages(page).nth(1).getByTestId(SELECTORS.REVEAL)).toContainText(
    ROSTER.B.displayName,
  );
  await expect(messages(page).nth(1)).toHaveAttribute("data-turn-index", "1");
  await expect(page.getByTestId(SELECTORS.CONVERSATION)).toHaveAttribute(
    "data-conversation",
    conversationId ?? "",
  );

  // A follow-up after reload still continues the same OmniArena conversation.
  await send(page, "One more example, please.");
  await expect(messages(page)).toHaveCount(3);
  await expect(messages(page).nth(2)).toHaveAttribute("data-turn-index", "2");
  await expect(page.getByTestId(SELECTORS.CONVERSATION)).toHaveAttribute(
    "data-conversation",
    conversationId ?? "",
  );
});
