// Playwright config for the documentation screenshots (`npm run screenshots`).
//
// Separate from `playwright.config.ts` on purpose: the suite asserts behaviour
// as fast as it can, this run poses the same app for the camera — retina
// viewport, forced light mode, and the demo provider that streams slowly enough
// to photograph mid-stream.
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const upstreamDir = fileURLToPath(new URL("../.upstream", import.meta.url));

const ARENA_PORT = process.env.SCREENSHOT_ARENA_PORT ?? "3401";
const APP_PORT = process.env.SCREENSHOT_APP_PORT ?? "3402";
const POSTGRES_URL =
  process.env.SCREENSHOT_POSTGRES_URL ??
  "postgres://postgres:postgres@127.0.0.1:5433/postgres";
const arenaOrigin = `http://127.0.0.1:${ARENA_PORT}`;

export default defineConfig({
  expect: { timeout: 30_000 },
  fullyParallel: false,
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        // Retina PNGs at a normal desktop size.
        colorScheme: "light",
        deviceScaleFactor: 2,
        viewport: { height: 800, width: 1280 },
      },
    },
  ],
  reporter: [["list"]],
  retries: 0,
  testDir: "./screenshots",
  timeout: 300_000,
  // `localhost`, not 127.0.0.1: the template's auth cookies assume a
  // trustworthy origin, same as the e2e config.
  use: { baseURL: `http://localhost:${APP_PORT}` },
  webServer: [
    {
      command: "npx tsx harness/arena-demo.ts",
      env: { SCREENSHOT_ARENA_PORT: ARENA_PORT },
      reuseExistingServer: false,
      timeout: 60_000,
      url: `${arenaOrigin}/health`,
    },
    {
      command: `node_modules/.bin/next dev --port ${APP_PORT}`,
      cwd: upstreamDir,
      env: {
        AUTH_SECRET: "omniarena-integration-screenshots-secret",
        OMNIARENA_URL: arenaOrigin,
        POSTGRES_URL,
      },
      reuseExistingServer: false,
      timeout: 180_000,
      url: `http://localhost:${APP_PORT}/ping`,
    },
  ],
});
