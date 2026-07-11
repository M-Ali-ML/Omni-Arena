import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
const schema = await readFile(schemaPath, "utf8");

try {
  await pool.query(schema);
  console.log("Database migration complete");
} finally {
  await pool.end();
}
