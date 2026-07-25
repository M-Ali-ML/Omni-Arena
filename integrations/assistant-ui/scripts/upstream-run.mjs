// Runs a script of the patched upstream example (dev / build / start) with this
// integration's ports and arena URL, so callers never have to cd into the
// gitignored clone.
//
//   node scripts/upstream-run.mjs dev [-- extra next args]
import { spawn } from "node:child_process";
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
const appDir = path.join(integrationDir, ".upstream", pin.app);

if (!existsSync(appDir)) {
  console.error(
    `Upstream app is missing at .upstream/${pin.app}. Run: npm run setup`,
  );
  process.exit(1);
}

const [script = "dev", ...rest] = process.argv.slice(2);
const port = process.env.APP_PORT ?? "3100";
const nextArgs =
  script === "build" ? [] : ["--port", port, "--hostname", "127.0.0.1"];

const child = spawn(
  "npx",
  ["--yes", pin.packageManager, "exec", "next", script, ...nextArgs, ...rest],
  {
    cwd: appDir,
    stdio: "inherit",
    env: {
      ...process.env,
      OMNIARENA_URL: process.env.OMNIARENA_URL ?? "http://127.0.0.1:3011",
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 0));
