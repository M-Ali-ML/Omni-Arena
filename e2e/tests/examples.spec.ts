import { expect, test } from "@playwright/test";
import { fingerprintOf, ROSTER } from "./arena-fixtures.js";

const NEXT_URL = `http://127.0.0.1:${process.env.E2E_NEXT_PORT ?? "3102"}`;
const VITE_URL = `http://127.0.0.1:${process.env.E2E_VITE_PORT ?? "3103"}`;

const SLOT_A = fingerprintOf(ROSTER.A.providerModelId);
const SLOT_B = fingerprintOf(ROSTER.B.providerModelId);

test.describe("example apps (headless browser)", () => {
  test("vercel-ai-chatbot: streams both models, votes, reveals", async ({
    page,
  }) => {
    await page.goto(NEXT_URL);
    await page.getByTestId("prompt-input").fill("hello from playwright");
    await page.getByTestId("send").click();

    // Distinct fingerprints prove each column carries its own model's answer.
    await expect(page.getByTestId("slot-a")).toContainText(SLOT_A, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("slot-b")).toContainText(SLOT_B);

    // Nothing names a model until the vote lands.
    await expect(page.getByTestId("reveal-a")).toHaveCount(0);
    await expect(page.getByTestId("reveal-b")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain("Mock Model");

    const voteLeft = page.getByTestId("vote-left");
    await expect(voteLeft).toBeEnabled({ timeout: 20_000 });
    await voteLeft.click();

    await expect(page.getByTestId("reveal-a")).toHaveText(
      ROSTER.A.displayName,
    );
    await expect(page.getByTestId("reveal-b")).toHaveText(
      ROSTER.B.displayName,
    );
  });

  test("assistant-ui: renders Model A via runtime, Model B alongside, votes", async ({
    page,
  }) => {
    await page.goto(VITE_URL);
    await page.getByTestId("composer-input").fill("hello assistant-ui");
    await page.getByTestId("composer-send").click();

    await expect(page.getByTestId("thread")).toContainText(SLOT_A, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("slot-b")).toContainText(SLOT_B);

    await expect(page.getByTestId("reveal")).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain("Mock Model");

    const voteLeft = page.getByTestId("vote-left");
    await expect(voteLeft).toBeEnabled({ timeout: 20_000 });
    await voteLeft.click();

    const reveal = page.getByTestId("reveal");
    await expect(reveal).toContainText(ROSTER.A.displayName);
    await expect(reveal).toContainText(ROSTER.B.displayName);
  });
});
