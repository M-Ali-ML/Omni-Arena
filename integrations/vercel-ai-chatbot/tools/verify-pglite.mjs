// Proves the PGlite TCP shim behaves like a real Postgres for the upstream app:
// runs the actual upstream migration and the query shapes the app issues.
// Prints PGLITE_VERIFY_OK on success, exits non-zero otherwise.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { startPgliteServer } from "./pglite-server.mjs";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(
  toolsDir,
  "..",
  ".upstream",
  "lib",
  "db",
  "migrations",
  "0000_initial.sql"
);

/**
 * A pooled client with several live connections must not corrupt the shared
 * PGlite backend, and concurrent transactions must stay isolated.
 */
async function verifyConcurrency(url) {
  const notices = [];
  const pool = postgres(url, {
    max: 10,
    onnotice: (notice) => notices.push(notice.message),
  });
  try {
    await pool`create table probe (id serial primary key, n int)`;
    await Promise.all(
      Array.from(
        { length: 40 },
        (_, i) => pool`insert into probe (n) values (${i})`
      )
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        pool
          .begin(async (tx) => {
            await tx`insert into probe (n) values (${1000 + i})`;
            await tx`select count(*) from probe`;
            if (i === 3) {
              throw new Error("intentional rollback");
            }
          })
          .catch(() => {})
      )
    );
    const [{ total }] = await pool`select count(*)::int as total from probe`;
    assert.equal(total, 47, "40 inserts + 7 committed transactions");
    const [{ leaked }] =
      await pool`select count(*)::int as leaked from probe where n = 1003`;
    assert.equal(leaked, 0, "rolled-back transaction must not persist");
    assert.deepEqual(notices, [], "no session-state warnings from interleaving");
    console.log("concurrency (pool of 10, 8 parallel transactions) ok");
  } finally {
    await pool.end({ timeout: 5 });
  }
}

/** An on-disk dataDir must survive a full server restart. */
async function verifyPersistence() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "pglite-verify-"));
  try {
    const first = await startPgliteServer({ dataDir });
    const writer = postgres(first.url, { max: 1 });
    await writer`create table persisted (id int primary key)`;
    await writer`insert into persisted values (42)`;
    await writer.end({ timeout: 5 });
    await first.close();

    const second = await startPgliteServer({ dataDir });
    const reader = postgres(second.url, { max: 1 });
    const [row] = await reader`select id from persisted`;
    assert.equal(row.id, 42);
    await reader.end({ timeout: 5 });
    await second.close();
    console.log("on-disk dataDir survives restart");
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
}

const startedAt = Date.now();
const server = await startPgliteServer();
const bootMs = Date.now() - startedAt;
console.log(`server ready in ${bootMs}ms on ${server.url}`);

const sql = postgres(server.url, { max: 1, onnotice: () => {} });

let failure = null;
try {
  const migration = await readFile(migrationPath, "utf8");
  await sql.unsafe(migration);
  console.log("migration applied");

  const tables = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name
  `;
  assert.deepEqual(
    tables.map((row) => row.table_name),
    ["Chat", "Document", "Message_v2", "Stream", "Suggestion", "User", "Vote_v2"]
  );

  // gen_random_uuid()/now() defaults must fire server-side.
  const [user] = await sql`
    insert into "User" ("email", "password")
    values (${"e2e@example.com"}, ${"hashed"})
    returning *
  `;
  assert.match(
    user.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  );
  assert.ok(user.createdAt instanceof Date);
  assert.equal(user.emailVerified, false);

  const [chat] = await sql`
    insert into "Chat" ("createdAt", "title", "userId")
    values (${new Date()}, ${"first chat"}, ${user.id})
    returning *
  `;
  assert.equal(chat.visibility, "private");

  const parts = [{ type: "text", text: "hello from pglite" }];
  const [message] = await sql`
    insert into "Message_v2" ("chatId", "role", "parts", "attachments", "createdAt")
    values (${chat.id}, ${"user"}, ${sql.json(parts)}, ${sql.json([])}, ${new Date()})
    returning *
  `;
  assert.deepEqual(message.parts, parts);

  const rows = await sql`
    select m."id", m."parts", c."title", u."email"
    from "Message_v2" m
    join "Chat" c on c."id" = m."chatId"
    join "User" u on u."id" = c."userId"
    where m."chatId" = ${chat.id}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "e2e@example.com");

  // Parameterised UPDATE with a json value — the extended protocol path.
  const nextParts = [{ type: "text", text: "edited" }];
  const updated = await sql`
    update "Message_v2" set "parts" = ${sql.json(nextParts)}
    where "id" = ${message.id}
    returning "parts"
  `;
  assert.deepEqual(updated[0].parts, nextParts);

  // Composite primary key + composite foreign key.
  const documentCreatedAt = new Date();
  const [document] = await sql`
    insert into "Document" ("createdAt", "title", "content", "userId")
    values (${documentCreatedAt}, ${"doc"}, ${"body"}, ${user.id})
    returning *
  `;
  await sql`
    insert into "Suggestion" (
      "documentId", "documentCreatedAt", "originalText",
      "suggestedText", "userId", "createdAt"
    ) values (
      ${document.id}, ${documentCreatedAt}, ${"a"},
      ${"b"}, ${user.id}, ${new Date()}
    )
  `;

  await sql`
    insert into "Vote_v2" ("chatId", "messageId", "isUpvoted")
    values (${chat.id}, ${message.id}, ${true})
  `;

  // Foreign keys must actually be enforced.
  await assert.rejects(
    sql`
      insert into "Chat" ("createdAt", "title", "userId")
      values (${new Date()}, ${"orphan"}, ${"00000000-0000-0000-0000-000000000000"})
    `,
    /violates foreign key constraint/
  );

  // Transactions, as used by the app's multi-statement writes.
  await sql.begin(async (tx) => {
    await tx`update "Chat" set "visibility" = ${"public"} where "id" = ${chat.id}`;
  });
  const [reread] = await sql`select "visibility" from "Chat" where "id" = ${chat.id}`;
  assert.equal(reread.visibility, "public");

  await verifyConcurrency(server.url);
  await verifyPersistence();
} catch (error) {
  failure = error;
} finally {
  await sql.end({ timeout: 5 });
  await server.close();
}

// Set the exit code only after teardown: closing PGlite shuts down its
// Emscripten runtime, which resets `process.exitCode` to 0.
if (failure) {
  console.error(failure);
  process.exitCode = 1;
} else {
  console.log("PGLITE_VERIFY_OK");
}
