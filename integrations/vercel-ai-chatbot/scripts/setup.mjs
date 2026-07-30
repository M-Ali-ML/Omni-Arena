// One command to get the real vercel/ai-chatbot template running with the
// OmniArena arena layer:
//
//   1. clone (or update) the pinned upstream commit into .upstream/ (gitignored)
//   2. reset tracked files, so re-running is idempotent
//   3. copy the arena overlay in and apply the anchored patches
//   4. point `@omni-arena/react` at the monorepo SDK (file: dep) and build it
//   5. write .env.local if it is missing (random AUTH_SECRET, no cloud services)
//   6. install dependencies with the upstream's pinned pnpm
//
// Usage: node scripts/setup.mjs [--skip-install] [--postgres-url=<url>]
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatches, copyOverlay } from "./overlay.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const integrationDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(integrationDir, "../..");
const reactSdkDir = path.join(repoRoot, "packages/react-sdk");
const upstreamDir = path.join(integrationDir, ".upstream");
const overlayDir = path.join(integrationDir, "overlay");

const args = process.argv.slice(2);
const skipInstall = args.includes("--skip-install");
const postgresUrl =
  args.find((arg) => arg.startsWith("--postgres-url="))?.split("=")[1] ??
  process.env.POSTGRES_URL ??
  "postgres://omni_arena:omni_arena@localhost:5432/ai_chatbot";

const pin = JSON.parse(
  await readFile(path.join(integrationDir, "upstream.json"), "utf8"),
);

function run(command, commandArgs, cwd = integrationDir) {
  console.log(`\n> ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`\nFailed: ${command} ${commandArgs.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

function capture(command, commandArgs, cwd = integrationDir) {
  const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8" });
  return result.stdout?.trim() ?? "";
}

if (existsSync(path.join(upstreamDir, ".git"))) {
  console.log(`Reusing clone at ${path.relative(integrationDir, upstreamDir)}`);
} else {
  run("git", ["clone", "--filter=blob:none", pin.repo, upstreamDir]);
}

// Pin the checkout, then throw away any previous overlay edits to tracked files
// so the anchored patches always run against pristine upstream sources.
const hasCommit =
  spawnSync("git", ["cat-file", "-e", `${pin.commit}^{commit}`], {
    cwd: upstreamDir,
  }).status === 0;
if (!hasCommit) {
  run("git", ["fetch", "origin", pin.commit], upstreamDir);
}
run("git", ["checkout", "--detach", pin.commit], upstreamDir);
run("git", ["checkout", "--", "."], upstreamDir);

const head = capture("git", ["rev-parse", "HEAD"], upstreamDir);
if (head !== pin.commit) {
  console.error(`Expected upstream HEAD ${pin.commit}, got ${head}`);
  process.exit(1);
}

const copied = await copyOverlay(overlayDir, upstreamDir);
console.log(`\nCopied ${copied.length} overlay files:`);
for (const file of copied) {
  console.log(`  + ${file}`);
}

const patched = await applyPatches(upstreamDir);
console.log(`\nPatched ${patched.length} upstream files:`);
for (const file of patched) {
  console.log(`  ~ ${file}`);
}

/**
 * Overlay sources import `@omni-arena/react`. The upstream clone is outside the
 * monorepo workspace, so point it at `packages/react-sdk` via a `file:` dep and
 * make sure `dist/` exists before Next resolves the package.
 */
async function linkReactSdk() {
  if (!existsSync(path.join(reactSdkDir, "package.json"))) {
    console.error(`Expected @omni-arena/react at ${reactSdkDir}`);
    process.exit(1);
  }
  run("npm", ["run", "build", "--workspace", "@omni-arena/react"], repoRoot);

  const pkgPath = path.join(upstreamDir, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const rel = path.relative(upstreamDir, reactSdkDir).split(path.sep).join("/");
  const spec = `file:${rel}`;
  pkg.dependencies = { ...pkg.dependencies, "@omni-arena/react": spec };
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`\nLinked @omni-arena/react -> ${spec}`);
  return spec;
}

const reactSdkSpec = await linkReactSdk();

const envPath = path.join(upstreamDir, ".env.local");
if (existsSync(envPath)) {
  console.log("\nKeeping existing .env.local");
} else {
  await writeFile(
    envPath,
    `# Written by integrations/vercel-ai-chatbot/scripts/setup.mjs.
# Arena mode needs no model-provider key in this app: OmniArena owns the models.
AUTH_SECRET=${randomBytes(32).toString("base64")}
POSTGRES_URL=${postgresUrl}
OMNIARENA_URL=http://localhost:3001
`,
  );
  console.log("\nWrote .env.local");
}

if (skipInstall) {
  // e2e re-runs setup with --skip-install; still ensure the local SDK is linked
  // into node_modules after package.json was rewritten above.
  if (existsSync(path.join(upstreamDir, "node_modules"))) {
    run(
      "npx",
      ["--yes", pin.packageManager, "add", `@omni-arena/react@${reactSdkSpec}`],
      upstreamDir,
    );
  } else {
    console.log("\nSkipping install (--skip-install); no node_modules yet");
  }
} else {
  // Mutating package.json invalidates the upstream lockfile pin for this one
  // local dep, so install without --frozen-lockfile.
  run("npx", ["--yes", pin.packageManager, "install"], upstreamDir);
}

console.log(`
Done. Upstream pinned at ${pin.commit} (${pin.committedAt}).

Next:
  1. Postgres for the chatbot   npm run db:up   (docker)  or  npm run pg  (docker-free)
  2. Migrate the chatbot schema npm run db:migrate
  3. Start OmniArena            (repo root) see the integration README
  4. Start the app              npm run dev   -> http://localhost:3000
`);
