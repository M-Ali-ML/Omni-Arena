// Runs one of the upstream template's own npm scripts inside the pinned clone,
// with its pinned pnpm. Keeps every command in this integration runnable from
// the integration directory instead of asking people to cd into .upstream.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const integrationDir = path.resolve(scriptDir, "..");
const upstreamDir = path.join(integrationDir, ".upstream");

if (!existsSync(path.join(upstreamDir, "package.json"))) {
  console.error(
    "The upstream clone is missing. Run `npm run setup` in " +
      "integrations/vercel-ai-chatbot first.",
  );
  process.exit(1);
}

const pin = JSON.parse(
  readFileSync(path.join(integrationDir, "upstream.json"), "utf8"),
);
const [script, ...rest] = process.argv.slice(2);

if (!script) {
  console.error("Usage: node scripts/upstream-run.mjs <upstream-npm-script>");
  process.exit(1);
}

const child = spawn(
  "npx",
  ["--yes", pin.packageManager, "run", script, ...rest],
  { cwd: upstreamDir, shell: process.platform === "win32", stdio: "inherit" },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
