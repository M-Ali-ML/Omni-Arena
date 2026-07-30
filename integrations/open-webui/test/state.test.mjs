#!/usr/bin/env node
/**
 * Unit coverage for ChatStore's durable continuation map.
 * Runs on the host (or in the bridge container) with a temp file — no arena.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatStore } from "../bridge/lib/state.mjs";

let failures = 0;
let passes = 0;

const check = (name, condition, detail = "") => {
  if (condition) {
    passes += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const dir = mkdtempSync(path.join(tmpdir(), "bridge-state-"));
const persistPath = path.join(dir, "continuations.json");

try {
  console.log("\nChatStore persistence");
  {
    const store = new ChatStore({ persistPath, ttlMs: 60_000 });
    store.setContinuation("chat-a", "11111111-1111-4111-8111-111111111111");
    store.setMatchup("chat-a", { matchupId: "m1" });
    check(
      "peek returns the stored conversation id",
      store.peekContinuation("chat-a") ===
        "11111111-1111-4111-8111-111111111111",
    );

    const onDisk = JSON.parse(readFileSync(persistPath, "utf8"));
    check(
      "file records only continuations (not matchups)",
      onDisk.continuations["chat-a"]?.continueFrom ===
        "11111111-1111-4111-8111-111111111111" &&
        onDisk.continuations["chat-a"].matchup === undefined,
    );

    const reloaded = new ChatStore({ persistPath, ttlMs: 60_000 });
    check(
      "a fresh ChatStore reloads the continuation after 'restart'",
      reloaded.peekContinuation("chat-a") ===
        "11111111-1111-4111-8111-111111111111",
    );
    check(
      "matchup state is not durable (in-process only)",
      reloaded.get("chat-a").matchup === null,
    );
  }

  console.log("\nChatStore clear + TTL");
  {
    const store = new ChatStore({ persistPath, ttlMs: 60_000 });
    store.clearContinuation("chat-a");
    check(
      "clear drops the in-memory mapping",
      store.peekContinuation("chat-a") === null,
    );
    const reloaded = new ChatStore({ persistPath, ttlMs: 60_000 });
    check(
      "clear is durable across reload",
      reloaded.peekContinuation("chat-a") === null,
    );

    const short = new ChatStore({ persistPath, ttlMs: 1 });
    short.setContinuation("chat-b", "22222222-2222-4222-8222-222222222222");
    // Force the entry past TTL without waiting on the wall clock.
    short.get("chat-b").touchedAt = Date.now() - 10;
    check(
      "TTL expiry clears a stale continuation",
      short.peekContinuation("chat-b") === null,
    );
    const afterSweep = new ChatStore({ persistPath, ttlMs: 60_000 });
    check(
      "TTL expiry is written through to disk",
      afterSweep.peekContinuation("chat-b") === null,
    );
  }

  console.log("\nChatStore corrupt / missing file");
  {
    const missing = new ChatStore({
      persistPath: path.join(dir, "does-not-exist.json"),
      ttlMs: 60_000,
    });
    check(
      "missing file starts empty",
      missing.peekContinuation("anyone") === null,
    );

    const badPath = path.join(dir, "corrupt.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(badPath, "{not-json", "utf8");
    const corrupt = new ChatStore({ persistPath: badPath, ttlMs: 60_000 });
    check(
      "corrupt file is ignored rather than crashing",
      corrupt.peekContinuation("anyone") === null,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  `\n${passes} passed, ${failures} failed (ChatStore unit)`,
);
process.exit(failures === 0 ? 0 : 1);
