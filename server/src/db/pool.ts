import "../env.js";
import { Pool } from "pg";

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://omni_arena:omni_arena@localhost:5432/omni_arena",
});
