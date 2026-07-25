import { expect, test } from "@playwright/test";

/**
 * Drives the real Open WebUI at http://localhost:3200 the way a person would:
 * pick the arena pseudo-model, ask a question, read two anonymous answers, vote,
 * and see the reveal. Nothing here talks to the bridge or to Omni-Arena
 * directly — if these pass, arena mode genuinely survives inside Open WebUI.
 *
 * Requires the stack to be up: `npm run up` and `npm run arena`.
 */

const settle = async (page) => {
  await page.waitForLoadState("networkidle");
  await page.keyboard.press("Escape");
};

/** Sends a message and waits for the assistant turn that follows it to finish. */
async function send(page, text) {
  const input = page.locator("#chat-input");
  await input.click();
  await input.fill(text);
  await page.keyboard.press("Enter");
  await expect(input).toHaveText("", { timeout: 10_000 });
}

/** The rendered assistant messages, in order. */
const answers = (page) => page.locator(".chat-assistant");

/**
 * The mock provider opens every answer with `Mock answer, variant <tag>`, where
 * the tag is a neutral per-model fingerprint (`server/src/providers/mock.ts`).
 * It names no model — blindness — while still telling two slots apart, so it is
 * what these tests compare instead of the display names they used to read.
 */
const VARIANT = /Mock answer, variant ([0-9a-f]{4})/g;
const variantsIn = (text) =>
  new Set([...text.matchAll(VARIANT)].map((match) => match[1]));

async function waitForAnswer(page, index, matcher) {
  await expect(answers(page).nth(index)).toContainText(matcher, { timeout: 60_000 });
}

test.describe("Omni-Arena inside Open WebUI", () => {
  test("blind duel: two anonymous answers, a vote, then the reveal", async ({ page }) => {
    await page.goto("/?models=omni-arena-duel");
    await settle(page);

    await send(page, "What is a vector database?");

    const first = answers(page).first();
    await expect(first).toContainText("Answer A", { timeout: 60_000 });
    await expect(first).toContainText("Answer B");
    await expect(first).toContainText("identities are revealed once you do");

    // Blindness: the matchup is over but no model name has been shown — not in
    // the bridge's framing, and not in the answers themselves.
    const beforeVote = await first.innerText();
    expect(beforeVote).not.toMatch(/revealed as|A was|B was/);
    expect(beforeVote).not.toMatch(/Mock Model|mock-(alpha|beta)/);

    await send(page, "!a");
    await waitForAnswer(page, 1, "Recorded");

    // The seeded mock roster is Alpha vs Beta; both identities appear together.
    const reveal = answers(page).nth(1);
    await expect(reveal).toContainText(/A was Mock Model (Alpha|Beta)/);
    await expect(reveal).toContainText(/B was Mock Model (Alpha|Beta)/);
    await page.screenshot({ path: "docs/duel-vote-reveal.png", fullPage: true });
  });

  test("side-by-side: Open WebUI's compare view renders one arena slot per column", async ({
    page,
  }) => {
    await page.goto("/?models=omni-arena-a,omni-arena-b");
    await settle(page);

    await send(page, "Explain HTTP/3 in two sentences.");

    // Two columns, both anonymous, both streamed from the same matchup.
    await expect(answers(page)).toHaveCount(2, { timeout: 60_000 });
    const [left, right] = [answers(page).nth(0), answers(page).nth(1)];
    await expect(left).toContainText("Mock answer, variant", { timeout: 60_000 });
    await expect(right).toContainText("Mock answer, variant", { timeout: 60_000 });

    // The rendezvous joined the two parallel requests: neither column fell back
    // to the "only one slot selected" path, and they are different models.
    await expect(left).not.toContainText("Only ");
    await expect(right).not.toContainText("Only ");
    const leftText = await left.innerText();
    const rightText = await right.innerText();
    expect([...variantsIn(leftText)]).toHaveLength(1);
    expect([...variantsIn(rightText)]).toHaveLength(1);
    expect([...variantsIn(leftText)]).not.toEqual([...variantsIn(rightText)]);

    // The column headers are the pseudo-models, so nothing identifies a model.
    await expect(page.getByText("Omni-Arena · Anonymous A").first()).toBeVisible();
    await expect(page.getByText("Omni-Arena · Anonymous B").first()).toBeVisible();
    await page.screenshot({ path: "docs/side-by-side-blind.png", fullPage: true });

    // One vote resolves both columns; each reveals its own slot.
    await send(page, "!b");
    await expect(answers(page)).toHaveCount(4, { timeout: 60_000 });
    await expect(answers(page).nth(2)).toContainText("This column was", { timeout: 60_000 });
    await expect(answers(page).nth(3)).toContainText("This column was", { timeout: 60_000 });
    await expect(answers(page).nth(3)).toContainText("your pick");
  });

  test("raw adapter passthrough renders slot A alone, coherently", async ({ page }) => {
    await page.goto("/?models=omni-arena-raw");
    await settle(page);

    await send(page, "Compare TCP and UDP.");
    await waitForAnswer(page, 0, "Mock answer, variant");

    // Open WebUI reads `choices[0]` by array position. Omni-Arena used to emit
    // one choice per frame with the slot in `index`, which spliced both models'
    // tokens into this single message; it now pins slot A to `choices[0]` of
    // every frame, so what renders is one model's answer and nothing else.
    // Slot B is still on the wire as `choices[1]`, and still discarded here —
    // which is why the arena needs the bridge rather than raw passthrough.
    const rendered = await answers(page).first().innerText();
    expect(rendered).toContain("Mock answer, variant");
    expect([...variantsIn(rendered)]).toHaveLength(1);
    expect(await answers(page).count()).toBe(1);
    await page.screenshot({ path: "docs/raw-passthrough-garbled.png", fullPage: true });
  });

  test("single mode: one answer, and nothing to vote on", async ({ page }) => {
    await page.goto("/?models=omni-arena-single");
    await settle(page);

    await send(page, "Name three primes.");
    await waitForAnswer(page, 0, "Mock answer, variant");
    await expect(answers(page).first()).not.toContainText("identities are revealed");

    await send(page, "!a");
    await waitForAnswer(page, 1, /nothing to vote/i);
  });

  test("leaderboard is reachable from inside the chat", async ({ page }) => {
    await page.goto("/?models=omni-arena-duel");
    await settle(page);

    await send(page, "!leaderboard");
    await waitForAnswer(page, 0, "Omni-Arena leaderboard");
    await expect(answers(page).first()).toContainText("Mock Model Alpha");
  });

  test("Open WebUI refuses to send a `/`-prefixed message (why commands use `!`)", async ({
    page,
  }) => {
    await page.goto("/?models=omni-arena-duel");
    await settle(page);

    const input = page.locator("#chat-input");
    await input.click();
    await input.fill("/a");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);

    // The text is still sitting in the composer: `/` opens Open WebUI's own
    // prompt-shortcut menu and the message is never submitted.
    await expect(input).toHaveText("/a");
    await expect(answers(page)).toHaveCount(0);
  });
});
