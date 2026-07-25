import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const upstreamDir = fileURLToPath(new URL("../.upstream", import.meta.url));

const ARENA_PORT = process.env.E2E_ARENA_PORT ?? "3201";
const APP_PORT = process.env.E2E_APP_PORT ?? "3202";
const POSTGRES_URL =
  process.env.E2E_POSTGRES_URL ??
  "postgres://postgres:postgres@127.0.0.1:5433/postgres";
const arenaOrigin = `http://127.0.0.1:${ARENA_PORT}`;

export default defineConfig({
  expect: { timeout: 20_000 },
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  reporter: [["list"]],
  retries: 0,
  testDir: "./tests",
  timeout: 180_000,
  // `localhost`, not 127.0.0.1: the template's auth cookies (and its own e2e
  // suite) assume a trustworthy-origin dev server.
  use: { baseURL: `http://localhost:${APP_PORT}` },
  webServer: [
    {
      command: "npx tsx harness/arena.ts",
      env: { E2E_ARENA_PORT: ARENA_PORT },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      url: `${arenaOrigin}/health`,
    },
    {
      // The real template in dev mode — the only mode it supports over plain
      // HTTP, because a production build issues `__Secure-` auth cookies. The
      // production build is still exercised: scripts/e2e.mjs runs `next build`
      // before Playwright. Postgres is the PGlite server that script starts.
      command: `node_modules/.bin/next dev --port ${APP_PORT}`,
      cwd: upstreamDir,
      env: {
        AUTH_SECRET: "omniarena-integration-e2e-secret",
        OMNIARENA_URL: arenaOrigin,
        POSTGRES_URL,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      url: `http://localhost:${APP_PORT}/ping`,
    },
  ],
});
