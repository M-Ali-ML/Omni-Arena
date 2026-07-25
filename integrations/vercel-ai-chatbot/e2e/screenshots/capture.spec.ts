// Captures the documentation screenshots for this integration.
//
//   npm run screenshots        (from integrations/vercel-ai-chatbot/)
//
// Everything here is the real app: the vendored vercel/ai-chatbot template with
// the arena overlay, its NextAuth guest session and Postgres history, driven
// against a real OmniArena server. Only the model provider is a stub
// (`harness/arena-demo.ts`), so regenerating the images costs nothing and needs
// no key. Selectors are the ones the e2e suite already relies on.
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";

const outputDir = fileURLToPath(
  new URL("../../../../docs/images/integrations/vercel-ai-chatbot", import.meta.url),
);

const TURN_ONE = "Explain what a JSON Web Token is, and when I should not use one.";
const TURN_TWO = "Now in two sentences, for a junior developer.";
const SINGLE = "Give me a checklist for rotating a signing key.";

/** Hides the parts of a dev server that should not end up in the docs. */
async function prepare(page: Page): Promise<void> {
  await page.addStyleTag({
    // Next's dev overlay/build indicator renders in this custom element.
    content: "nextjs-portal { display: none !important; }",
  });
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    path: `${outputDir}/${name}.png`,
    scale: "device",
  });
}

async function send(page: Page, prompt: string): Promise<void> {
  await page.getByTestId("multimodal-input").fill(prompt);
  await page.getByTestId("send-button").click();
}

/**
 * A round is over when the matchup header drops its `· streaming` marker. The
 * vote bar cannot stand in for it here: a `single` round has none.
 */
async function waitForStreamEnd(matchup: Locator): Promise<void> {
  await expect(matchup.getByText("· streaming")).toHaveCount(0);
}

async function openChat(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("multimodal-input")).toBeVisible();
  await prepare(page);
}

test.beforeAll(async () => {
  await mkdir(outputDir, { recursive: true });
});

test("captures the arena flow inside the template", async ({ page }) => {
  await openChat(page);
  await send(page, TURN_ONE);

  const matchup = page.getByTestId("arena-matchup").first();
  const slotA = matchup.getByTestId("arena-slot-a");
  const slotB = matchup.getByTestId("arena-slot-b");

  // 1. Mid-stream. The demo provider paces slot A at ~34ms/word and slot B at
  // ~46ms/word, so waiting for a word from the middle of each answer lands the
  // camera while both columns are still filling in.
  await expect(slotA).toContainText("database lookup");
  await expect(slotB).toContainText("signs the result");
  await expect(matchup.getByText("vote once both answers finish")).toBeVisible();
  await shoot(page, "01-streaming");

  // 2. Both answers finished, five-way vote bar live, identities still hidden.
  const voteLeft = matchup.getByTestId("arena-vote-left");
  await expect(voteLeft).toBeEnabled();
  await expect(matchup.getByTestId("arena-reveal-a")).toHaveCount(0);
  await shoot(page, "02-vote");

  // 3. The reveal: names, the winner chip, and what the next message will do.
  await voteLeft.click();
  await expect(matchup.getByTestId("arena-reveal-a")).toContainText("winner");
  await expect(matchup.getByTestId("arena-reveal-b")).toBeVisible();
  await shoot(page, "03-reveal");

  // 4. Multi-turn: the follow-up continues the winning answer's conversation.
  await send(page, TURN_TWO);
  const second = page.getByTestId("arena-matchup").nth(1);
  await expect(second.getByTestId("arena-turn")).toHaveText("turn 2");
  await expect(second.getByTestId("arena-vote-left")).toBeEnabled();
  // The list has auto-scrolled to the newest turn, which frames turn 2 under
  // the tail of turn 1 — exactly the continuation this shot is about.
  await page.waitForTimeout(500);
  await shoot(page, "04-multi-turn");

  // 5. The leaderboard, with this session's votes already counted.
  await second.getByTestId("arena-vote-left").click();
  await expect(second.getByTestId("arena-reveal-a")).toContainText("winner");
  await page.getByTestId("arena-leaderboard-open").click();
  await expect(page.getByTestId("arena-leaderboard-row")).toHaveCount(2);
  await page.waitForTimeout(500);
  await shoot(page, "05-leaderboard");
});

test("captures a single, non-votable round", async ({ page }) => {
  await openChat(page);

  // The harness runs ARENA_TRIGGER=manual, so opting out yields mode `single`:
  // one column, no vote controls, everything else unchanged.
  await page.getByTestId("arena-toggle").click();
  await expect(page.getByTestId("arena-toggle")).toHaveText("Compare: off");
  await send(page, SINGLE);

  const matchup = page.getByTestId("arena-matchup").first();
  await expect(matchup.getByTestId("arena-mode")).toHaveText("Single model");
  await expect(matchup.getByTestId("arena-no-vote")).toBeVisible();
  await expect(matchup.getByTestId("arena-slot-b")).toHaveCount(0);
  await waitForStreamEnd(matchup);
  await shoot(page, "06-single-model");
});
