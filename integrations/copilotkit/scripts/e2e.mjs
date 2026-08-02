// One command for the whole Playwright flow: build the Next app (unless
// --dev), ensure Chromium is present, then run the suite. Playwright itself
// starts OmniArena (mock provider) and the app via webServer.
//
//   node scripts/e2e.mjs [--dev] [-- extra playwright args]
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const integrationDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
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

// `next start` needs a build; dev mode compiles on demand.
if (!dev) run("npm", ["run", "build"]);

run("npx", ["playwright", "install", "chromium"]);
run("npx", ["playwright", "test", ...passthrough], {
  ...(dev ? { ARENA_E2E_DEV: "1" } : {}),
});
