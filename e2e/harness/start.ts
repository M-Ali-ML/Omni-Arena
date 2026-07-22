import { startHarness } from "./server.js";

const port = Number(process.env.E2E_ARENA_PORT ?? 3101);
const handle = await startHarness({
  port,
  webOrigin: process.env.E2E_WEB_ORIGIN,
});

// Playwright's webServer waits for this port's /health before running tests.
console.log(`OmniArena e2e harness listening on ${handle.origin}`);

const shutdown = (): void => {
  void handle.close().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
