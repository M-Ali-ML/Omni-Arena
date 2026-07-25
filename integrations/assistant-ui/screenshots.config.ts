import { defineConfig } from "@playwright/test";

/**
 * The documentation-screenshot run: same two servers as `playwright.config.ts`
 * (OmniArena on 3011, the patched upstream app on 3100), but shot at retina
 * scale against the showcase provider (`ARENA_SHOWCASE=1`), which streams
 * identity-free answers slowly enough to catch mid-run.
 *
 * Driven by `npm run screenshots`; the app is served by `next start` so no dev
 * overlay lands in the images.
 */
const ARENA_PORT = process.env.ARENA_PORT ?? "3011";
const APP_PORT = process.env.APP_PORT ?? "3100";
const arenaUrl = `http://127.0.0.1:${ARENA_PORT}`;

export default defineConfig({
  testDir: "./screenshots",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  },
  webServer: [
    {
      command: "npm run arena",
      url: `${arenaUrl}/health`,
      // Never reuse: a stray arena from `npm run dev` would be serving the
      // stock mock provider, whose answers name the model before the vote.
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ARENA_PORT, ARENA_TRIGGER: "manual", ARENA_SHOWCASE: "1" },
    },
    {
      command: "npm run start",
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { APP_PORT, OMNIARENA_URL: arenaUrl },
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
