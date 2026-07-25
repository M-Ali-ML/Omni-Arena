import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Captures the images in docs/images/integrations/assistant-ui/ by driving the
 * real app the same way tests/arena.spec.ts does — same selectors, same flow —
 * and photographing it at the interesting moments.
 *
 * Run it with `npm run screenshots`, not `npm test`: it needs the showcase
 * provider (`ARENA_SHOWCASE=1`, wired up by screenshots.config.ts).
 */

const outputDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/images/integrations/assistant-ui",
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
  await expect(page.getByTestId("arena-controls")).toBeVisible();
  await page.addStyleTag({ content: STILL });
};

const send = async (page: Page, prompt: string): Promise<void> => {
  const composer = page.getByRole("textbox").first();
  await composer.click();
  await composer.fill(prompt);
  await composer.press("Enter");
};

const shot = async (page: Page, name: string): Promise<void> => {
  // Blur the composer and park the pointer in dead space, so no caret, focus
  // ring or hover tooltip ends up in a documentation image.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(1275, 795);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outputDir, name) });
};

const messages = (page: Page) => page.getByTestId("arena-message");

/**
 * Wait until a column stops growing. A single-model round has no vote bar to
 * read "still running" off, so the text itself is the signal.
 */
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

  const first = messages(page).first();
  const slotA = first.getByTestId("arena-slot-A");
  const slotB = first.getByTestId("arena-slot-B");
  const vote = first.getByTestId("arena-vote-left");

  // 1. Mid-run: both columns are live, one visibly ahead, the vote bar still
  // disabled. The showcase provider paces the two slots differently so this
  // window is a second wide rather than a race.
  await expect
    .poll(
      async () => {
        const [a, b, running] = await Promise.all([
          slotA.innerText(),
          slotB.innerText(),
          vote.isDisabled(),
        ]);
        return running && a.length > 220 && b.length > 110;
      },
      { intervals: [40], timeout: 60_000 },
    )
    .toBe(true);
  await shot(page, "01-streaming.png");

  // 2. Both answers complete, still anonymous, five-way vote bar enabled.
  await expect(vote).toBeEnabled();
  await expect(slotA).toHaveAttribute("data-revealed", "false");
  await expect(slotB).toHaveAttribute("data-revealed", "false");
  await shot(page, "02-vote.png");

  // 3. The reveal: identities in the column headers, the pick badged.
  await vote.click();
  await expect(first.getByTestId("arena-reveal")).toContainText("Mock Model");
  await expect(slotA).toHaveAttribute("data-revealed", "true");
  await expect(first.getByTestId("arena-can-continue")).toBeVisible();
  await shot(page, "03-reveal.png");

  // 4. Turn 2 in the same OmniArena conversation, continued from the winner,
  // with a fresh blind matchup for the follow-up.
  await send(page, "What should I do when the token expires?");
  const second = messages(page).nth(1);
  await expect(second).toHaveAttribute("data-turn-index", "1");
  await expect(second.getByTestId("arena-vote-left")).toBeEnabled();
  // Park turn 1's reveal at the top of the thread so the shot shows the whole
  // story — who won the last round, and the follow-up it is being continued
  // from — instead of a lone second matchup.
  await page.evaluate(() => {
    const reveal = document.querySelector('[data-testid="arena-reveal"]');
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
  await page.getByTestId("arena-toggle").click();
  await expect(page.getByTestId("arena-toggle")).toHaveAttribute(
    "data-enabled",
    "false",
  );

  await send(page, "Give me a checklist for storing tokens in a browser.");

  const message = messages(page).first();
  await expect(message).toHaveAttribute("data-mode", "single");
  await expect(message.getByTestId("arena-not-votable")).toBeVisible();
  await expect(message.getByTestId("arena-vote-bar")).toHaveCount(0);
  await settled(message.getByTestId("arena-slot-A"));
  await shot(page, "05-single-model.png");
});
