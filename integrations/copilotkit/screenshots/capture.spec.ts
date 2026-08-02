import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Captures docs/images/integrations/copilotkit/ by driving the CopilotKit app
 * the same way the parallel e2e track does — same data-testid selectors, same
 * flow — and photographing the five house moments.
 *
 * Run with `npm run screenshots` (screenshots.config.ts), not the default
 * playwright config.
 */

// RECONCILE: mirror tests/selectors.ts
const T = {
  ARENA_TOGGLE: "ARENA_TOGGLE",
  SLOT_COLUMN_A: "SLOT_COLUMN_A",
  SLOT_COLUMN_B: "SLOT_COLUMN_B",
  VOTE_BAR: "VOTE_BAR",
  REVEAL_BADGE: "REVEAL_BADGE",
  CONTINUATION_INDICATOR: "CONTINUATION_INDICATOR",
  SINGLE_MODEL_NOTICE: "SINGLE_MODEL_NOTICE",
} as const;

const outputDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/images/integrations/copilotkit",
);

/** Freeze animations and hide the composer caret so no shot lands mid-fade. */
const STILL = `
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-delay: 0ms !important;
    transition-duration: 1ms !important;
    transition-delay: 0ms !important;
  }
  * { caret-color: transparent !important; }
`;

const open = async (page: Page): Promise<void> => {
  await page.goto("/");
  await expect(page.getByTestId(T.ARENA_TOGGLE)).toBeVisible();
  await page.addStyleTag({ content: STILL });
};

const send = async (page: Page, prompt: string): Promise<void> => {
  const composer = page.getByRole("textbox").first();
  await composer.click();
  await composer.fill(prompt);
  await composer.press("Enter");
};

const shot = async (page: Page, name: string): Promise<void> => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(1275, 795);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outputDir, name) });
};

/**
 * RECONCILE: mirror tests/arena.spec.ts if a MATCHUP_ROUND wrapper test id is
 * added; for now scope columns by index within the thread.
 */
const round = (page: Page, index: number) => ({
  slotA: page.getByTestId(T.SLOT_COLUMN_A).nth(index),
  slotB: page.getByTestId(T.SLOT_COLUMN_B).nth(index),
  voteBar: page.getByTestId(T.VOTE_BAR).nth(index),
});

const settled = async (column: Locator): Promise<void> => {
  let previous = "";
  await expect
    .poll(
      async () => {
        const text = await column.innerText();
        const stable = text.length > 0 && text === previous;
        previous = text;
        return stable;
      },
      { intervals: [300], timeout: 60_000 },
    )
    .toBe(true);
};

test("arena round: stream, vote, reveal, continue", async ({ page }) => {
  await open(page);
  await send(page, "Explain JSON Web Tokens in simple terms.");

  const first = round(page, 0);
  const { slotA, slotB, voteBar } = first;

  // 1. Mid-run: both columns live, vote bar still disabled.
  await expect
    .poll(
      async () => {
        const [a, b, running] = await Promise.all([
          slotA.innerText(),
          slotB.innerText(),
          voteBar.isDisabled(),
        ]);
        return running && a.length > 220 && b.length > 110;
      },
      { intervals: [40], timeout: 60_000 },
    )
    .toBe(true);
  await shot(page, "01-streaming.png");

  // 2. Both answers complete, still anonymous, five-way vote bar enabled.
  await expect(voteBar).toBeEnabled();
  // RECONCILE: pre-reveal anonymity attribute if the parallel UI uses data-revealed
  await shot(page, "02-vote.png");

  // 3. Reveal: model names and your-pick badge.
  // RECONCILE: exact vote control label inside VOTE_BAR (A better / left)
  await voteBar.getByRole("button").first().click();
  await expect(page.getByTestId(T.REVEAL_BADGE).first()).toContainText("Mock");
  await expect(page.getByTestId(T.CONTINUATION_INDICATOR).first()).toBeVisible();
  await shot(page, "03-reveal.png");

  // 4. Turn 2 in the same conversation — fresh blind matchup for the follow-up.
  await send(page, "What should I do when the token expires?");
  const second = round(page, 1);
  await expect(second.voteBar).toBeEnabled();
  // RECONCILE: data-turn-index or turn label if exposed on the round container
  await page.evaluate(() => {
    const reveal = document.querySelector('[data-testid="REVEAL_BADGE"]');
    let scroller = reveal?.parentElement ?? null;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
      scroller = scroller.parentElement;
    }
    if (!reveal || !scroller) return;
    scroller.scrollTop +=
      reveal.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      12;
  });
  await page.waitForTimeout(400);
  await shot(page, "04-multi-turn.png");
});

test("arena mode off: one model, nothing to vote on", async ({ page }) => {
  await open(page);
  await page.getByTestId(T.ARENA_TOGGLE).click();
  await expect(page.getByTestId(T.ARENA_TOGGLE)).toHaveAttribute(
    "data-enabled",
    "false",
  );

  await send(page, "Give me a checklist for storing tokens in a browser.");

  const { slotA } = round(page, 0);
  await expect(page.getByTestId(T.SINGLE_MODEL_NOTICE).first()).toBeVisible();
  await expect(page.getByTestId(T.VOTE_BAR)).toHaveCount(0);
  await settled(slotA);
  await shot(page, "05-single-model.png");
});
