#!/usr/bin/env node
// Boots Omni-Arena from this repository's own source on port 3021, backed by
// the Postgres container this integration owns (host port 5452).
//
// It runs the real production entrypoint (`server/src/server.ts`), the real
// migrations and the repository's own mock seed, so what Open WebUI talks to is
// Omni-Arena as shipped — not a re-implementation. Nothing outside
// integrations/open-webui/ is modified.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const integrationDir = path.resolve(here, "..");
const repoRoot = path.resolve(integrationDir, "../..");

const PORT = process.env.ARENA_PORT ?? "3021";
const DATABASE_URL =
  process.env.ARENA_DATABASE_URL ??
  "postgres://omni_arena:omni_arena@localhost:5452/omni_arena";

/** `1` (default) uses the deterministic mock provider; `0` uses real providers. */
const useMock = (process.env.ARENA_MOCK ?? "1") !== "0";

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: repoRoot,
    ...options,
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
};

const psql = (sql) => {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "omni_arena",
      "-d",
      "omni_arena",
      "-tAc",
      sql,
    ],
    { cwd: integrationDir, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr ?? ""}`);
  }
  return result.stdout.trim();
};

const waitForPostgres = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = spawnSync(
      "docker",
      ["compose", "exec", "-T", "postgres", "pg_isready", "-U", "omni_arena", "-d", "omni_arena"],
      { cwd: integrationDir, stdio: "ignore" },
    );
    if (probe.status === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    "Postgres (integrations/open-webui, host port 5452) never became ready. Run `docker compose up -d postgres` first.",
  );
};

console.log("[arena] waiting for Postgres on 5452...");
await waitForPostgres();

const baseEnv = {
  DATABASE_URL,
  PORT,
  MATCHUP_TOKEN_SECRET:
    process.env.MATCHUP_TOKEN_SECRET ?? "open-webui-integration-secret-not-for-production",
  HARNESS_VERSION: "open-webui-integration",
};

console.log("[arena] applying migrations...");
run("npx", ["tsx", "server/src/db/migrate.ts"], { env: baseEnv });

console.log(`[arena] seeding roster (${useMock ? "mock" : "real"} providers)...`);
run("npx", ["tsx", useMock ? "server/src/db/seed.mock.ts" : "server/src/db/seed.ts"], {
  env: baseEnv,
});

// ARENA_TRIGGER=manual is what lets the bridge choose per request whether a
// prompt becomes a blind matchup or a single answer, so the `omni-arena-single`
// pseudo-model can exist alongside the duel. It requires a designated model id.
const defaultModel =
  process.env.ARENA_DEFAULT_MODEL ??
  psql("SELECT id FROM models WHERE enabled ORDER BY display_name LIMIT 1");
if (!defaultModel) {
  throw new Error("No enabled model found after seeding; cannot set ARENA_DEFAULT_MODEL");
}

const env = {
  ...baseEnv,
  ARENA_TRIGGER: process.env.ARENA_TRIGGER ?? "manual",
  ARENA_DEFAULT_MODEL: defaultModel,
  MATCHMAKER: process.env.MATCHMAKER ?? "random",
  ...(useMock ? { ARENA_MOCK_PROVIDER: "1" } : {}),
};

console.log(
  `[arena] starting Omni-Arena on :${PORT} (trigger=${env.ARENA_TRIGGER}, default model ${defaultModel})`,
);

const child = spawn("npx", ["tsx", "server/src/server.ts"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, ...env },
});

const stop = () => child.kill("SIGTERM");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
child.once("exit", (code) => process.exit(code ?? 0));
