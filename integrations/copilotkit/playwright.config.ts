import { defineConfig } from "@playwright/test";

const ARENA_PORT = process.env.ARENA_PORT ?? "3031";
const APP_PORT = process.env.APP_PORT ?? "3300";
const arenaUrl = `http://127.0.0.1:${ARENA_PORT}`;

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${APP_PORT}` },
  webServer: [
    {
      // OmniArena itself: real Fastify app, pg-mem, deterministic mock provider.
      // App builder ships `npm run arena` (harness) mirroring assistant-ui.
      command: "npm run arena",
      url: `${arenaUrl}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { ARENA_PORT, ARENA_TRIGGER: "manual" },
    },
    {
      // Minimal Next.js + CopilotKit app (ArenaHttpAgent → /api/copilotkit).
      command: `npm run ${process.env.ARENA_E2E_DEV ? "dev" : "start"}`,
      url: `http://127.0.0.1:${APP_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: { APP_PORT, OMNIARENA_URL: arenaUrl, PORT: APP_PORT },
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
