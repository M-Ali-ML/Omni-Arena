// Second, harder proof: drizzle-orm/postgres-js talking to the PGlite TCP shim,
// using the upstream app's own schema.ts (Node strips the TS types natively).
// Prints DRIZZLE_VERIFY_OK on success, exits non-zero otherwise.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startPgliteServer } from "./pglite-server.mjs";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const upstreamDir = path.join(toolsDir, "..", ".upstream");

/**
 * Prefer the upstream clone's own copies so we test what the app actually
 * runs; fall back to the tools dir if that install is missing/incomplete.
 */
async function loadDeps() {
  const requireUpstream = createRequire(path.join(upstreamDir, "package.json"));
  try {
    const specifiers = [
      "drizzle-orm",
      "drizzle-orm/postgres-js",
      "drizzle-orm/postgres-js/migrator",
      "postgres",
    ];
    const [orm, pgjs, migrator, pg] = await Promise.all(
      specifiers.map((id) =>
        import(pathToFileURL(requireUpstream.resolve(id)).href)
      )
    );
    return {
      source: "upstream",
      eq: orm.eq,
      drizzle: pgjs.drizzle,
      migrate: migrator.migrate,
      postgres: pg.default,
    };
  } catch (error) {
    console.log(`upstream deps unavailable (${error.message}); using tools dir`);
    const [orm, pgjs, migrator, pg] = await Promise.all([
      import("drizzle-orm"),
      import("drizzle-orm/postgres-js"),
      import("drizzle-orm/postgres-js/migrator"),
      import("postgres"),
    ]);
    return {
      source: "tools",
      eq: orm.eq,
      drizzle: pgjs.drizzle,
      migrate: migrator.migrate,
      postgres: pg.default,
    };
  }
}

const { source, eq, drizzle, migrate, postgres } = await loadDeps();
console.log(`drizzle-orm + postgres loaded from: ${source}`);

const schema = await import(
  pathToFileURL(path.join(upstreamDir, "lib", "db", "schema.ts")).href
);

const server = await startPgliteServer();
const client = postgres(server.url, { max: 1, onnotice: () => {} });
const db = drizzle(client);

let failure = null;
try {
  // The app's real `db:migrate` path, journal table and all.
  await migrate(db, {
    migrationsFolder: path.join(upstreamDir, "lib", "db", "migrations"),
  });
  const [journal] = await client`
    select count(*)::int as count from "drizzle"."__drizzle_migrations"
  `;
  assert.equal(journal.count, 1);

  const [inserted] = await db
    .insert(schema.user)
    .values({ email: "drizzle@example.com", password: "hashed" })
    .returning();
  assert.equal(inserted.email, "drizzle@example.com");
  assert.ok(inserted.createdAt instanceof Date);

  const found = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.email, "drizzle@example.com"));
  assert.equal(found.length, 1);
  assert.equal(found[0].id, inserted.id);
  assert.equal(found[0].isAnonymous, false);

  // json columns and joins through the ORM, as the chat queries do.
  const [chat] = await db
    .insert(schema.chat)
    .values({ createdAt: new Date(), title: "drizzle chat", userId: inserted.id })
    .returning();

  const parts = [{ type: "text", text: "typed round-trip" }];
  await db.insert(schema.message).values({
    attachments: [],
    chatId: chat.id,
    createdAt: new Date(),
    parts,
    role: "user",
  });

  const messages = await db
    .select({ parts: schema.message.parts, title: schema.chat.title })
    .from(schema.message)
    .innerJoin(schema.chat, eq(schema.chat.id, schema.message.chatId));
  assert.deepEqual(messages[0].parts, parts);
  assert.equal(messages[0].title, "drizzle chat");
} catch (error) {
  failure = error;
} finally {
  await client.end({ timeout: 5 });
  await server.close();
}

// Set the exit code only after teardown: closing PGlite shuts down its
// Emscripten runtime, which resets `process.exitCode` to 0.
if (failure) {
  console.error(failure);
  process.exitCode = 1;
} else {
  console.log("DRIZZLE_VERIFY_OK");
}
