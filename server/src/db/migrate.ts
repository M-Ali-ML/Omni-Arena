import { runMigrations } from "./migrations.js";
import { pool } from "./pool.js";

try {
  const ran = await runMigrations(pool);
  console.log(
    ran.length > 0
      ? `Applied migrations: ${ran.join(", ")}`
      : "Database already up to date",
  );
} finally {
  await pool.end();
}
