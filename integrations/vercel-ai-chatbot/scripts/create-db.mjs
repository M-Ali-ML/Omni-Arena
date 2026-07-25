// Creates the chatbot's database inside the repo's docker-compose Postgres.
// The template keeps its own schema ("User", "Chat", "Message_v2", …) so it
// gets its own database on the same server rather than sharing OmniArena's.
import pg from "pg";

const adminUrl =
  process.env.ADMIN_DATABASE_URL ??
  "postgres://omni_arena:omni_arena@localhost:5432/omni_arena";
const databaseName = process.env.CHATBOT_DATABASE ?? "ai_chatbot";

const client = new pg.Client({ connectionString: adminUrl });

try {
  await client.connect();
  await client.query(`CREATE DATABASE "${databaseName}"`);
  console.log(`Created database ${databaseName}`);
} catch (error) {
  // 42P04 = duplicate_database, which is the happy path on re-runs.
  if (error?.code === "42P04") {
    console.log(`Database ${databaseName} already exists`);
  } else {
    console.error(
      `Could not create ${databaseName} on ${adminUrl}:`,
      error?.message ?? error,
    );
    process.exit(1);
  }
} finally {
  await client.end().catch(() => undefined);
}
