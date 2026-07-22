// Orchestrates the end-to-end suite:
//   1. install deps for the e2e harness + both example apps (skipped if already
//      present; force with E2E_FORCE_INSTALL=1)
//   2. build each example app — this is the "each example builds" smoke check
//   3. install the Playwright Chromium browser
//   4. run Playwright, which boots the OmniArena harness (pg-mem + mock
//      provider) and the two example servers, then drives the full arena flow
//
// Deterministic and CI-friendly: no real API keys, no external LLM calls.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(e2eDir, "..");
const examples = [
  path.join(repoRoot, "examples", "vercel-ai-chatbot"),
  path.join(repoRoot, "examples", "assistant-ui"),
];

function run(command, args, cwd) {
  const label = path.relative(repoRoot, cwd) || ".";
  console.log(`\n> (${label}) ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`\nCommand failed: ${command} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

const forceInstall = process.env.E2E_FORCE_INSTALL === "1";
for (const dir of [e2eDir, ...examples]) {
  if (forceInstall || !existsSync(path.join(dir, "node_modules"))) {
    run("npm", ["install"], dir);
  }
}

for (const dir of examples) {
  run("npm", ["run", "build"], dir);
}

run("npx", ["playwright", "install", "chromium"], e2eDir);
run("npx", ["playwright", "test"], e2eDir);
