import { defineConfig, devices } from "@playwright/test";

/**
 * Drives the real Open WebUI at http://localhost:3200. The stack has to be
 * running already (`npm run up` + `npm run arena`) — Playwright deliberately
 * does not start it, because Omni-Arena runs on the host and Open WebUI in
 * Docker, and a half-started stack produces confusing failures.
 */
export default defineConfig({
  testDir: "./tests",
  // direct-probe.spec.js is a one-off experiment that needs its own overlay.
  testIgnore: ["**/direct-probe.spec.js"],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.OPEN_WEBUI_URL ?? "http://localhost:3200",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
