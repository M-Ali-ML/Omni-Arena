// One command for the whole Playwright flow: make sure the upstream clone
// exists and is patched, build it, make sure Chromium is present, then run the
// suite. Playwright itself starts OmniArena (mock provider) and the app.
//
//   node scripts/e2e.mjs [--dev] [-- extra playwright args]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const integrationDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pin = JSON.parse(
  await readFile(path.join(integrationDir, "upstream.json"), "utf8"),
);

const argv = process.argv.slice(2);
const dev = argv.includes("--dev");
const passthrough = argv.filter((arg) => arg !== "--dev");

const run = (command, args, extraEnv = {}) => {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: integrationDir,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// Always re-apply the overlay so the suite tests the committed sources, never a
// clone that drifted since the last setup run. Only the clone and its install —
// the expensive parts — are conditional.
if (existsSync(path.join(integrationDir, ".upstream", pin.app))) {
  run("node", ["scripts/setup.mjs", "--skip-install"]);
} else {
  run("node", ["scripts/setup.mjs"]);
}

// `next start` needs a build; dev mode compiles on demand.
if (!dev) run("node", ["scripts/upstream-run.mjs", "build"]);

run("npx", ["playwright", "install", "chromium"]);
run("npx", ["playwright", "test", ...passthrough], {
  ...(dev ? { ARENA_E2E_DEV: "1" } : {}),
});
