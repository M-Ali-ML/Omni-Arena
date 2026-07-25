// The OmniArena service for this integration test: the repo's own e2e harness
// (real Fastify app, pg-mem, deterministic mock provider) started with
// ARENA_TRIGGER=manual so the suite can drive both a blind matchup (opted in)
// and a single non-votable answer (opted out) against one server.
import { MOCK_ALPHA, startHarness } from "../../../../e2e/harness/server.js";

const port = Number(process.env.E2E_ARENA_PORT ?? 3201);
const handle = await startHarness({
  modeConfig: { defaultModel: MOCK_ALPHA, trigger: "manual" },
  port,
});

console.log(`OmniArena harness (trigger=manual) listening on ${handle.origin}`);

const shutdown = (): void => {
  void handle.close().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
