#!/usr/bin/env node
// Runs both suites against a stack that is already up:
//   1. the HTTP-level contract Open WebUI depends on (inside the bridge container)
//   2. the Playwright suite that drives the real Open WebUI UI at :3200
// Fails fast with a readable message when a piece of the stack is missing,
// because a half-started stack produces baffling test output.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const reachable = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
};

const preflight = [
  ["Omni-Arena (host :3021)", "http://localhost:3021/health", "npm run arena"],
  ["Open WebUI (:3200)", "http://localhost:3200/health", "npm run up"],
];

let missing = false;
for (const [label, url, remedy] of preflight) {
  const ok = await reachable(url);
  console.log(`${ok ? "  ok  " : " MISS "} ${label}`);
  if (!ok) {
    console.error(`        start it with: ${remedy}`);
    missing = true;
  }
}
if (missing) {
  process.exit(1);
}

const steps = [
  [
    "OpenAI-compatible surface (HTTP)",
    "docker",
    ["compose", "exec", "-T", "bridge", "node", "/app/test/openai-surface.test.mjs"],
  ],
  [
    "Open WebUI UI (Playwright)",
    "npx",
    ["playwright", "test", "--config", path.join(root, "e2e/playwright.config.js")],
  ],
];

for (const [label, command, args] of steps) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("\nAll suites passed.");
