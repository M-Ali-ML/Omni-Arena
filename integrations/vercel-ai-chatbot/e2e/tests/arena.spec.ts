import { expect, type Page, test } from "@playwright/test";
import { fingerprintOf, ROSTER } from "../../../../e2e/tests/arena-fixtures.js";

// This suite's harness is the repo's own e2e harness (see harness/arena.ts), so
// it seeds that roster and pins the same matchmaking RNG: slot A is always the
// first model, slot B the second.
const SLOT_A_MODEL = ROSTER.A.displayName;
const SLOT_B_MODEL = ROSTER.B.displayName;

// Before the vote those names must appear nowhere, so a pre-vote assertion
// identifies a slot by the mock provider's identity-free fingerprint instead.
const SLOT_A_ANSWER = fingerprintOf(ROSTER.A.providerModelId);
const SLOT_B_ANSWER = fingerprintOf(ROSTER.B.providerModelId);

async function send(page: Page, prompt: string): Promise<void> {
  await page.getByTestId("multimodal-input").fill(prompt);
  await page.getByTestId("send-button").click();
}

test.describe("vercel/ai-chatbot with the OmniArena arena layer", () => {
  test("streams two blind answers, votes, reveals, and continues the winner", async ({
    page,
  }) => {
    await page.goto("/");
    // Guest auth is granted by the template's own proxy redirect.
    await expect(page.getByTestId("multimodal-input")).toBeVisible();

    await send(page, "explain jwts in one sentence");

    const matchup = page.getByTestId("arena-matchup").first();
    await expect(matchup.getByTestId("arena-mode")).toHaveText("Blind matchup");
    // Two concurrent streams, one per model, over a single connection.
    await expect(matchup.getByTestId("arena-slot-a")).toContainText(
      SLOT_A_ANSWER,
    );
    await expect(matchup.getByTestId("arena-slot-b")).toContainText(
      SLOT_B_ANSWER,
    );
    // Identities stay hidden until a vote is cast: no reveal, and no model named
    // anywhere on the page — including the composer, where the template's picker
    // used to show whichever model it had selected.
    await expect(matchup.getByTestId("arena-reveal-a")).toHaveCount(0);
    await expect(page.getByTestId("arena-model-lock")).toHaveText(
      "Models chosen by the arena",
    );
    expect(await matchup.innerText()).not.toMatch(
      new RegExp(`${SLOT_A_MODEL}|${SLOT_B_MODEL}`),
    );

    const voteLeft = matchup.getByTestId("arena-vote-left");
    await expect(voteLeft).toBeEnabled();
    await voteLeft.click();

    await expect(matchup.getByTestId("arena-reveal-a")).toContainText(
      SLOT_A_MODEL,
    );
    await expect(matchup.getByTestId("arena-reveal-a")).toContainText("winner");
    await expect(matchup.getByTestId("arena-reveal-b")).toContainText(
      SLOT_B_MODEL,
    );
    await expect(matchup.getByTestId("arena-vote-error")).toHaveCount(0);

    // A decisive vote makes the round continuable: the follow-up must land on
    // turn 2 of the same OmniArena conversation.
    await send(page, "now shorter");

    const second = page.getByTestId("arena-matchup").nth(1);
    await expect(second.getByTestId("arena-turn")).toHaveText("turn 2");
    await expect(second.getByTestId("arena-slot-a")).toContainText(
      "now shorter",
    );
    await expect(second.getByTestId("arena-slot-b")).toContainText(
      "now shorter",
    );

    // Both slots and the recorded vote are persisted as message parts, so the
    // replayed history keeps the matchup intact.
    await page.reload();
    const replayed = page.getByTestId("arena-matchup").first();
    await expect(replayed.getByTestId("arena-slot-a")).toContainText(
      SLOT_A_MODEL,
    );
    await expect(replayed.getByTestId("arena-slot-b")).toContainText(
      SLOT_B_MODEL,
    );
    await expect(replayed.getByTestId("arena-reveal-a")).toContainText(
      "winner",
    );
    await expect(page.getByTestId("arena-matchup")).toHaveCount(2);
  });

  test("hides voting when the arena serves a single model", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("multimodal-input")).toBeVisible();

    // Opting out on a trigger=manual deployment yields mode "single":
    // one slot, no vote token, no vote UI.
    await page.getByTestId("arena-toggle").click();
    await expect(page.getByTestId("arena-toggle")).toHaveText("Compare: off");

    await send(page, "single model please");

    const matchup = page.getByTestId("arena-matchup").first();
    await expect(matchup.getByTestId("arena-mode")).toHaveText("Single model");
    // The harness answers a non-arena round with its default model, which is the
    // roster's slot-A model.
    await expect(matchup.getByTestId("arena-slot-a")).toContainText(
      SLOT_A_ANSWER,
    );
    await expect(matchup.getByTestId("arena-slot-b")).toHaveCount(0);
    await expect(matchup.getByTestId("arena-no-vote")).toBeVisible();
    await expect(matchup.getByTestId("arena-votes")).toHaveCount(0);
  });

  test("proxies the OmniArena leaderboard into the app", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("multimodal-input")).toBeVisible();

    await page.getByTestId("arena-leaderboard-open").click();
    const rows = page.getByTestId("arena-leaderboard-row");
    await expect(rows.first()).toContainText("Mock Model");
    await expect(rows).toHaveCount(2);
  });
});
