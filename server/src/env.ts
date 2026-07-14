import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "dotenv";

// Load the repo-root .env regardless of the process cwd (npm workspaces run
// scripts with cwd set to the package directory, not the repo root).
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../.env") });
