// Regenerates the documentation screenshots in
// docs/images/integrations/copilotkit/.
//
//   npm run screenshots
//
// Build the owned Next.js app, serve it with `next start` (no dev overlay),
// shoot a retina light-mode viewport against the showcase provider
// (identity-free answers, paced for a mid-stream frame), then quantise the
// PNGs. No credentials, no Docker, nothing spent. Unlike assistant-ui there
// is no upstream clone / overlay step — the app lives in this directory.
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const integrationDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputDir = path.resolve(
  integrationDir,
  "../../docs/images/integrations/copilotkit",
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

await mkdir(outputDir, { recursive: true });

// `next start` (no dev overlay in the corner of every shot) needs a build.
run("npm", ["run", "build"]);
run("npx", ["playwright", "install", "chromium"]);
run("npx", ["playwright", "test", "--config", "screenshots.config.ts"]);
run("node", ["scripts/optimize-pngs.mjs"]);
