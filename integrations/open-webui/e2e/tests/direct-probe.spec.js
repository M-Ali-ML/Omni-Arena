import { test } from "@playwright/test";

/**
 * Not part of the suite. Run only with the direct-probe overlay applied, to
 * record what Open WebUI does when it is pointed straight at Omni-Arena with
 * no bridge in between. See README, "Findings".
 */
test("direct connection to Omni-Arena", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "docs/direct-no-bridge.png", fullPage: true });
  console.log("BODY:\n", (await page.locator("body").innerText()).slice(0, 1200));
});
