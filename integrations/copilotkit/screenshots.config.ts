import { defineConfig } from "@playwright/test";

/**
 * Documentation-screenshot run for the CopilotKit integration: OmniArena harness
 * on 3031, the owned Next.js app on 3300, retina viewport, showcase provider
 * pacing. Driven by `npm run screenshots`; the app is served by `next start`
 * so no dev overlay lands in the images.
 */
const ARENA_PORT = process.env.ARENA_PORT ?? "3031";
const APP_PORT = process.env.APP_PORT ?? "3300";
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
