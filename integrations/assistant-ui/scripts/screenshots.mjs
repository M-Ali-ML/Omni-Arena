// Regenerates the documentation screenshots in
// docs/images/integrations/assistant-ui/.
//
//   npm run screenshots
//
// Same moving parts as `scripts/e2e.mjs` — the pinned upstream clone with the
// arena overlay, a real OmniArena on pg-mem — but pointed at
// screenshots.config.ts, which shoots a retina light-mode viewport against the
// showcase provider (identity-free answers, paced for a mid-stream frame).
// No credentials, no Docker, nothing spent.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const integrationDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputDir = path.resolve(
  integrationDir,
  "../../docs/images/integrations/assistant-ui",
);
const pin = JSON.parse(
  await readFile(path.join(integrationDir, "upstream.json"), "utf8"),
);

const run = (command, args, extraEnv = {}) => {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: integrationDir,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (!existsSync(path.join(integrationDir, ".upstream", pin.app))) {
  run("node", ["scripts/setup.mjs"]);
} else {
  // Re-apply the overlay so the images always show the committed sources.
  run("node", ["scripts/setup.mjs", "--skip-install"]);
}

await mkdir(outputDir, { recursive: true });

// `next start` (no dev overlay in the corner of every shot) needs a build.
run("node", ["scripts/upstream-run.mjs", "build"]);
run("npx", ["playwright", "install", "chromium"]);
run("npx", ["playwright", "test", "--config", "screenshots.config.ts"]);
run("node", ["scripts/optimize-pngs.mjs"]);
