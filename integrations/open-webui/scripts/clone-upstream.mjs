#!/usr/bin/env node
// Clones Open WebUI at the commit pinned in upstream.json into a gitignored
// .upstream/. Nothing in this integration patches or builds that checkout — the
// container image is what runs. It exists so every claim README.md makes about
// Open WebUI's behaviour can be checked against the code that actually shipped
// in the pinned tag.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pin = JSON.parse(readFileSync(path.join(root, "upstream.json"), "utf8"));
const target = path.join(root, ".upstream");

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
};

if (!existsSync(target)) {
  console.log(`Cloning ${pin.repo} (blobless) into .upstream/ ...`);
  run("git", ["clone", "--filter=blob:none", "--no-checkout", pin.repo, target], root);
}

console.log(`Checking out ${pin.tag} (${pin.commit}) ...`);
run("git", ["checkout", "-q", pin.commit], target);

const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" })
  .stdout.trim();
if (head !== pin.commit) {
  throw new Error(`Expected ${pin.commit} but .upstream/ is at ${head}`);
}
console.log(`.upstream/ is at ${pin.tag} (${head})`);
