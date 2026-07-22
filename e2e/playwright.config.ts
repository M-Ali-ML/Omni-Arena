import { defineConfig } from "@playwright/test";

const ARENA_PORT = process.env.E2E_ARENA_PORT ?? "3101";
const NEXT_PORT = process.env.E2E_NEXT_PORT ?? "3102";
const VITE_PORT = process.env.E2E_VITE_PORT ?? "3103";
const arenaTarget = `http://127.0.0.1:${ARENA_PORT}`;

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  webServer: [
    {
      command: "npm run harness",
      url: `${arenaTarget}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { E2E_ARENA_PORT: ARENA_PORT },
    },
    {
      command: `npm --prefix ../examples/vercel-ai-chatbot run start -- -p ${NEXT_PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${NEXT_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { OMNIARENA_URL: arenaTarget },
    },
    {
      command: `npm --prefix ../examples/assistant-ui run preview -- --port ${VITE_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${VITE_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { ARENA_TARGET: arenaTarget },
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
