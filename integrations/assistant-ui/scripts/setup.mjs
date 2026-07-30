// One command to get the real assistant-ui monorepo running with the OmniArena
// arena layer:
//
//   1. clone (or reuse) the pinned upstream commit in .upstream/ (gitignored)
//   2. restore tracked files, so re-running is idempotent
//   3. copy the arena overlay in and apply the anchored patches
//   4. write .env.local if it is missing (no credentials involved)
//   5. build `@omni-arena/react` and link it into the example (file: dep)
//   6. install the example's workspace deps and build the packages it imports
//
// Usage: node scripts/setup.mjs [--skip-install] [--arena-url=http://127.0.0.1:3011]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
const arenaUrl =
  args.find((arg) => arg.startsWith("--arena-url="))?.split("=")[1] ??
  process.env.OMNIARENA_URL ??
  "http://127.0.0.1:3011";

const pin = JSON.parse(
  await readFile(path.join(integrationDir, "upstream.json"), "utf8"),
);
const appDir = path.join(upstreamDir, pin.app);

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
  return spawnSync(command, commandArgs, { cwd, encoding: "utf8" }).stdout?.trim() ?? "";
}

/**
 * Point the upstream example at the monorepo's `@omni-arena/react` via a
 * relative `file:` dependency. The overlay's `lib/arena/` imports the SDK's
 * protocol/session/vote primitives; without this link the example cannot
 * resolve them.
 */
async function ensureOmniArenaReactDep() {
  if (!existsSync(reactSdkDir)) {
    console.error(`@omni-arena/react missing at ${reactSdkDir}`);
    process.exit(1);
  }
  // Dist is what the package exports; build from the OmniArena workspace.
  run("npm", ["run", "build", "--workspace", "@omni-arena/react"], repoRoot);

  const pkgPath = path.join(appDir, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const rel = path.relative(appDir, reactSdkDir).split(path.sep).join("/");
  const spec = `file:${rel}`;
  const current = pkg.dependencies?.["@omni-arena/react"];
  if (current === spec) {
    console.log(`\n@omni-arena/react already at ${spec}`);
    return false;
  }
  pkg.dependencies = { ...(pkg.dependencies ?? {}), "@omni-arena/react": spec };
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`\nPinned @omni-arena/react → ${spec}`);
  return true;
}

async function linkOmniArenaReact() {
  // Symlink into the example's node_modules instead of `pnpm add`: the file:
  // dep is not in upstream's lockfile, and `pnpm add` would run the monorepo
  // `prepare` (husky + unused packages) which we deliberately skip on install.
  const linkPath = path.join(appDir, "node_modules", "@omni-arena", "react");
  await mkdir(path.dirname(linkPath), { recursive: true });
  await rm(linkPath, { recursive: true, force: true });
  await symlink(reactSdkDir, linkPath, "dir");
  console.log(
    `\nLinked @omni-arena/react → ${path.relative(appDir, reactSdkDir)}`,
  );
}

if (existsSync(path.join(upstreamDir, ".git"))) {
  console.log(`Reusing clone at ${path.relative(integrationDir, upstreamDir)}`);
} else {
  run("git", ["clone", "--filter=blob:none", pin.repo, upstreamDir]);
}

// Pin the checkout, then discard the previous overlay's edits to tracked files
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
for (const file of copied) console.log(`  + ${file}`);

const patched = await applyPatches(upstreamDir);
console.log(`\nPatched ${patched.length} upstream files:`);
for (const file of patched) console.log(`  ~ ${file}`);

const envPath = path.join(appDir, ".env.local");
if (existsSync(envPath)) {
  console.log("\nKeeping existing .env.local");
} else {
  await writeFile(
    envPath,
    `# Written by integrations/assistant-ui/scripts/setup.mjs.
# The app needs no model-provider key: OmniArena owns the models.
OMNIARENA_URL=${arenaUrl}
`,
  );
  console.log(`\nWrote ${path.relative(integrationDir, envPath)}`);
}

if (skipInstall) {
  console.log("\nSkipping install (--skip-install)");
  // Build + link the SDK even when the rest of the workspace install is skipped —
  // e2e re-runs setup with --skip-install after overlay edits.
  await ensureOmniArenaReactDep();
  await linkOmniArenaReact();
} else {
  const pnpm = ["--yes", pin.packageManager];
  // Only the example and the workspace packages it depends on — installing the
  // whole assistant-ui monorepo (docs site, every example) is not needed here.
  // `--ignore-scripts` because upstream's root `prepare` runs husky and builds
  // the devtools stylesheet, neither of which is installed under this filter.
  // Do this *before* pinning `@omni-arena/react` so the frozen lockfile still
  // matches pristine upstream package.json.
  run(
    "npx",
    [
      ...pnpm,
      "install",
      "--filter",
      `${appName(pin)}...`,
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
    upstreamDir,
  );
  // file: dep is not in upstream's lockfile — pin + symlink after the install.
  await ensureOmniArenaReactDep();
  await linkOmniArenaReact();
  // Those packages publish `dist`, so the app cannot import them from source.
  run("npx", [...pnpm, "exec", "turbo", "build", "--filter", `${appName(pin)}^...`, "--concurrency=6"], upstreamDir);
}

function appName(pinned) {
  return path.basename(pinned.app);
}

console.log(`
Done. Upstream assistant-ui pinned at ${pin.commit} (${pin.committedAt}).
Arena app: .upstream/${pin.app}

Next:
  1. Start OmniArena (mock provider, no keys)  npm run arena
  2. Start the app                             npm run dev   -> http://localhost:3100
  3. Or run the Playwright flow                npm test
`);
