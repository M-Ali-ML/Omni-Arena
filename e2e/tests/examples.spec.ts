import { expect, test } from "@playwright/test";

const NEXT_URL = `http://127.0.0.1:${process.env.E2E_NEXT_PORT ?? "3102"}`;
const VITE_URL = `http://127.0.0.1:${process.env.E2E_VITE_PORT ?? "3103"}`;

test.describe("example apps (headless browser)", () => {
  test("vercel-ai-chatbot: streams both models, votes, reveals", async ({
    page,
  }) => {
    await page.goto(NEXT_URL);
    await page.getByTestId("prompt-input").fill("hello from playwright");
    await page.getByTestId("send").click();

    await expect(page.getByTestId("slot-a")).toContainText(
      "Mock reply from Mock Model",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("slot-b")).toContainText(
      "Mock reply from Mock Model",
    );

    const voteLeft = page.getByTestId("vote-left");
    await expect(voteLeft).toBeEnabled({ timeout: 20_000 });
    await voteLeft.click();

    await expect(page.getByTestId("reveal-a")).toContainText("Mock Model");
    await expect(page.getByTestId("reveal-b")).toContainText("Mock Model");
  });

  test("assistant-ui: renders Model A via runtime, Model B alongside, votes", async ({
    page,
  }) => {
    await page.goto(VITE_URL);
    await page.getByTestId("composer-input").fill("hello assistant-ui");
    await page.getByTestId("composer-send").click();

    await expect(page.getByTestId("thread")).toContainText(
      "Mock reply from Mock Model Alpha",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("slot-b")).toContainText(
      "Mock reply from Mock Model Beta",
    );

    const voteLeft = page.getByTestId("vote-left");
    await expect(voteLeft).toBeEnabled({ timeout: 20_000 });
    await voteLeft.click();

    await expect(page.getByTestId("reveal")).toContainText("Mock Model");
  });
});
