// Drives the real integrated app end to end, with no credentials and no Docker:
//
//   PGlite over TCP        -> Postgres for the template (auth, chats, messages)
//   OmniArena e2e harness  -> real Fastify app on pg-mem + mock provider
//   next build / next start-> the actual vercel/ai-chatbot template + overlay
//   Playwright             -> streams, votes, reveals, continues, single mode
//
// Usage: node scripts/e2e.mjs [--skip-build] [-- <playwright args>]
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const integrationDir = path.resolve(scriptDir, "..");
const upstreamDir = path.join(integrationDir, ".upstream");
const e2eDir = path.join(integrationDir, "e2e");
const toolsDir = path.join(integrationDir, "tools");

const argv = process.argv.slice(2);
const skipBuild = argv.includes("--skip-build");
const playwrightArgs = argv.slice(argv.indexOf("--") + 1).filter((arg) => arg !== "--skip-build");

if (!existsSync(path.join(upstreamDir, "node_modules"))) {
  console.error(
    "The upstream clone is not installed. Run `npm run setup` in " +
      "integrations/vercel-ai-chatbot first.",
  );
  process.exit(1);
}

function run(command, args, cwd, env = {}) {
  console.log(`\n> (${path.relative(integrationDir, cwd) || "."}) ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  return result.status ?? 1;
}

function runOrExit(command, args, cwd, env) {
  const status = run(command, args, cwd, env);
  if (status !== 0) {
    process.exit(status);
  }
}

for (const dir of [integrationDir, toolsDir]) {
  if (!existsSync(path.join(dir, "node_modules"))) {
    runOrExit("npm", ["install"], dir);
  }
}

// Always re-apply the overlay so the suite tests the committed sources, never a
// clone that drifted since the last setup run.
runOrExit("node", ["scripts/setup.mjs", "--skip-install"], integrationDir);

/**
 * One Postgres for migrate, build and the app. It runs in its own process: the
 * steps below use blocking spawnSync, which would starve an in-process server's
 * event loop and time out every connection.
 */
async function startPostgres() {
  const child = spawn("node", ["tools/pglite-server.mjs", "--port", "0"], {
    cwd: integrationDir,
    stdio: ["ignore", "pipe", "inherit"],
  });

  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("PGlite server did not start within 30s")),
      30_000,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
      const match = output.match(/listening on (postgres:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`PGlite server exited with code ${code}`));
    });
  });

  return { child, url };
}

const postgres = await startPostgres();
console.log(`\nPGlite Postgres on ${postgres.url}`);

const appEnv = {
  AUTH_SECRET: "omniarena-integration-e2e-secret",
  E2E_POSTGRES_URL: postgres.url,
  POSTGRES_URL: postgres.url,
};

let status = 1;
try {
  runOrExit("node", ["scripts/upstream-run.mjs", "db:migrate"], integrationDir, appEnv);

  if (!skipBuild) {
    runOrExit("node", ["scripts/upstream-run.mjs", "build"], integrationDir, appEnv);
  }

  runOrExit("npx", ["playwright", "install", "chromium"], e2eDir);
  status = run(
    "npx",
    ["playwright", "test", "--config", "playwright.config.ts", ...playwrightArgs],
    e2eDir,
    appEnv,
  );
} finally {
  postgres.child.kill("SIGTERM");
}

process.exit(status);
