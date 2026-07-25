// Regenerates the documentation screenshots in
// docs/images/integrations/vercel-ai-chatbot/.
//
//   npm run screenshots
//
// Same moving parts as `scripts/e2e.mjs` — PGlite over TCP for the template's
// Postgres, a real OmniArena Fastify app for the arena, the vendored template
// in dev mode — but pointed at e2e/screenshots.config.ts, which shoots a retina
// light-mode viewport against a stub provider that streams slowly enough to be
// photographed mid-stream. No credentials, no Docker, no API cost.
//
// Ports are picked from the ephemeral range at startup so a screenshot run
// never collides with a dev server (or another agent) already on :3000/:3001.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const integrationDir = path.resolve(scriptDir, "..");
const upstreamDir = path.join(integrationDir, ".upstream");
const e2eDir = path.join(integrationDir, "e2e");
const toolsDir = path.join(integrationDir, "tools");

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

/** An ephemeral port the OS just handed out — free at the moment we ask. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(String(port)));
    });
  });
}

for (const dir of [integrationDir, toolsDir]) {
  if (!existsSync(path.join(dir, "node_modules"))) {
    runOrExit("npm", ["install"], dir);
  }
}

// Re-apply the overlay so the images always show the committed sources.
runOrExit("node", ["scripts/setup.mjs", "--skip-install"], integrationDir);

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

const env = {
  AUTH_SECRET: "omniarena-integration-screenshots-secret",
  POSTGRES_URL: postgres.url,
  SCREENSHOT_APP_PORT: await freePort(),
  SCREENSHOT_ARENA_PORT: await freePort(),
  SCREENSHOT_POSTGRES_URL: postgres.url,
};

let status = 1;
try {
  runOrExit("node", ["scripts/upstream-run.mjs", "db:migrate"], integrationDir, env);
  runOrExit("npx", ["playwright", "install", "chromium"], e2eDir);
  status = run(
    "npx",
    ["playwright", "test", "--config", "screenshots.config.ts"],
    e2eDir,
    env,
  );
  if (status === 0) {
    status = run("node", ["scripts/optimize-pngs.mjs"], integrationDir);
  }
} finally {
  postgres.child.kill("SIGTERM");
}

process.exit(status);
