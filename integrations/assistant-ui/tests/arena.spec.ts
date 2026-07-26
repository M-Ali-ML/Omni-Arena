import { expect, test, type Page } from "@playwright/test";
import { mockVariantTag } from "../../../server/src/providers/mock.js";

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
 * Drives the real upstream assistant-ui example (patched with the arena
 * overlay) against a real OmniArena running the deterministic mock provider:
 * prompt → two blind streams → vote → reveal → multi-turn follow-up → reload
 * rehydration, plus the non-votable single-model round.
 *
 * Vote tokens are acquired from the `x-arena-matchup` response header (the
 * stock AG-UI runtime drops `CUSTOM`), and continuation follows the vote
 * response's `continuable` flag.
 */

// The harness pins its matchmaking RNG, so slot A is always the roster's first
// model and slot B the second.
const SLOT_A_ANSWER = fingerprintOf(ROSTER.A.providerModelId);
const SLOT_B_ANSWER = fingerprintOf(ROSTER.B.providerModelId);

const send = async (page: Page, prompt: string): Promise<void> => {
  const composer = page.getByRole("textbox").first();
  await composer.click();
  await composer.fill(prompt);
  await composer.press("Enter");
};

const messages = (page: Page) => page.getByTestId("arena-message");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("arena-controls")).toBeVisible();
});

test("streams two blind answers, votes, reveals, and continues the winner", async ({
  page,
}) => {
  await expect(page.getByTestId("arena-toggle")).toHaveAttribute(
    "data-enabled",
    "true",
  );

  await send(page, "Explain JSON Web Tokens in simple terms.");

  const first = messages(page).first();
  const slotA = first.getByTestId("arena-slot-A");
  const slotB = first.getByTestId("arena-slot-B");

  // Both slots stream concurrently inside one AG-UI run, and the distinct
  // fingerprints prove each column carries its own model's answer.
  await expect(slotA).toContainText(SLOT_A_ANSWER);
  await expect(slotB).toContainText(SLOT_B_ANSWER);

  // Blind until the vote lands.
  await expect(slotA).toHaveAttribute("data-revealed", "false");
  await expect(slotB).toHaveAttribute("data-revealed", "false");
  await expect(first).toHaveAttribute("data-mode", "matchup");
  await expect(first).toHaveAttribute("data-turn-index", "0");

  const vote = first.getByTestId("arena-vote-left");
  await expect(vote).toBeEnabled();
  await vote.click();

  const reveal = first.getByTestId("arena-reveal");
  await expect(reveal).toContainText(ROSTER.A.displayName);
  await expect(reveal).toContainText(ROSTER.B.displayName);
  await expect(slotA).toHaveAttribute("data-revealed", "true");
  await expect(first.getByTestId("arena-can-continue")).toBeVisible();

  // A decisive vote leaves a winning response, so the arena can continue.
  const conversation = page.getByTestId("arena-conversation");
  await expect(conversation).not.toHaveAttribute("data-conversation", "");
  const conversationId = await conversation.getAttribute("data-conversation");

  await send(page, "Now give me an example token.");

  await expect(messages(page)).toHaveCount(2);
  const second = messages(page).nth(1);
  await expect(second.getByTestId("arena-slot-A")).toContainText(SLOT_A_ANSWER);
  await expect(second.getByTestId("arena-slot-B")).toContainText(SLOT_B_ANSWER);
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
  const vote = first.getByTestId("arena-vote-both_bad");
  await expect(vote).toBeEnabled();
  await vote.click();

  await expect(first.getByTestId("arena-reveal")).toContainText("Mock Model");
  await expect(first.getByTestId("arena-can-continue")).toHaveCount(0);
  await expect(page.getByTestId("arena-conversation")).toHaveAttribute(
    "data-conversation",
    "",
  );

  await send(page, "Say that again.");
  await expect(messages(page)).toHaveCount(2);
  // No winner to continue from, so OmniArena starts a new conversation.
  await expect(messages(page).nth(1)).toHaveAttribute("data-turn-index", "0");
});

test("hides the vote UI when the round is not votable", async ({ page }) => {
  await page.getByTestId("arena-toggle").click();
  await expect(page.getByTestId("arena-toggle")).toHaveAttribute(
    "data-enabled",
    "false",
  );

  await send(page, "Single model please.");

  const message = messages(page).first();
  await expect(message).toHaveAttribute("data-mode", "single");
  // A manual-trigger harness answers a non-arena round with its default model,
  // which is the roster's slot-A model.
  await expect(message.getByTestId("arena-slot-A")).toContainText(SLOT_A_ANSWER);
  await expect(message.getByTestId("arena-slot-B")).toHaveCount(0);
  await expect(message.getByTestId("arena-not-votable")).toBeVisible();
  await expect(message.getByTestId("arena-vote-bar")).toHaveCount(0);
});

test("rehydrates the thread after a reload", async ({ page }) => {
  await send(page, "Explain JSON Web Tokens in simple terms.");

  const first = messages(page).first();
  await expect(first.getByTestId("arena-slot-A")).toContainText(SLOT_A_ANSWER);
  await first.getByTestId("arena-vote-left").click();
  await expect(first.getByTestId("arena-reveal")).toContainText(
    ROSTER.A.displayName,
  );

  const conversationId = await page
    .getByTestId("arena-conversation")
    .getAttribute("data-conversation");
  expect(conversationId).toBeTruthy();

  await send(page, "Now give me an example token.");
  await expect(messages(page)).toHaveCount(2);
  await expect(messages(page).nth(1)).toHaveAttribute("data-turn-index", "1");
  await messages(page).nth(1).getByTestId("arena-vote-right").click();
  await expect(messages(page).nth(1).getByTestId("arena-reveal")).toContainText(
    ROSTER.B.displayName,
  );

  await page.reload();
  await expect(page.getByTestId("arena-controls")).toBeVisible();

  // Conversation GET rebuilds both turns, including reveals.
  await expect(messages(page)).toHaveCount(2);
  await expect(messages(page).first().getByTestId("arena-reveal")).toContainText(
    ROSTER.A.displayName,
  );
  await expect(messages(page).nth(1).getByTestId("arena-reveal")).toContainText(
    ROSTER.B.displayName,
  );
  await expect(messages(page).nth(1)).toHaveAttribute("data-turn-index", "1");
  await expect(page.getByTestId("arena-conversation")).toHaveAttribute(
    "data-conversation",
    conversationId ?? "",
  );

  // A follow-up after reload still continues the same OmniArena conversation.
  await send(page, "One more example, please.");
  await expect(messages(page)).toHaveCount(3);
  await expect(messages(page).nth(2)).toHaveAttribute("data-turn-index", "2");
  await expect(page.getByTestId("arena-conversation")).toHaveAttribute(
    "data-conversation",
    conversationId ?? "",
  );
});
