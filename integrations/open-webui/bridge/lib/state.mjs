import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deferred } from "./channel.mjs";
import { startRound } from "./arena.mjs";

/**
 * Per-conversation bridge state.
 *
 * A pure OpenAI-compatible surface is stateless, but a vote is inherently
 * stateful: it refers to a matchup that finished on an earlier request. The
 * bridge therefore keys state on Open WebUI's `X-OpenWebUI-Chat-Id` header,
 * which only exists when the deployment sets
 * `ENABLE_FORWARD_USER_INFO_HEADERS=true`. Without that header every browser
 * tab collapses onto one bucket and concurrent chats would steal each other's
 * vote tokens — see README, "What does not work".
 *
 * The same key holds the last *continuable* arena `conversationId`. Open WebUI
 * never gives the bridge a stable id of its own beyond that header, so a
 * missed mapping (TTL expiry, unknown chat, or a server 404) must degrade to a
 * fresh matchup — never attach to someone else's thread. Continuations are
 * also written to an optional JSON file on the bridge's data volume so a
 * container restart does not drop them.
 */
export class ChatStore {
  #chats = new Map();
  #ttlMs;
  #persistPath;

  constructor({ ttlMs = 60 * 60 * 1000, persistPath = null } = {}) {
    this.#ttlMs = ttlMs;
    this.#persistPath =
      typeof persistPath === "string" && persistPath.length > 0
        ? persistPath
        : null;
    this.#load();
  }

  #entry(key) {
    this.#sweep();
    let entry = this.#chats.get(key);
    if (!entry) {
      entry = {
        key,
        matchup: null,
        /** Set only after a vote the server marked `continuable`. */
        continueFrom: null,
        touchedAt: Date.now(),
      };
      this.#chats.set(key, entry);
    }
    entry.touchedAt = Date.now();
    return entry;
  }

  #sweep() {
    const cutoff = Date.now() - this.#ttlMs;
    let removed = false;
    for (const [key, entry] of this.#chats) {
      if (entry.touchedAt < cutoff) {
        this.#chats.delete(key);
        removed = true;
      }
    }
    if (removed) {
      this.#save();
    }
  }

  #load() {
    if (!this.#persistPath) {
      return;
    }
    let raw;
    try {
      raw = readFileSync(this.#persistPath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      console.warn(
        `[bridge] could not read continuation store ${this.#persistPath}:`,
        error.message ?? error,
      );
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.warn(
        `[bridge] ignoring corrupt continuation store ${this.#persistPath}:`,
        error.message ?? error,
      );
      return;
    }

    const entries =
      parsed && typeof parsed === "object" && parsed.continuations
        ? parsed.continuations
        : parsed;
    if (!entries || typeof entries !== "object") {
      return;
    }

    const cutoff = Date.now() - this.#ttlMs;
    for (const [key, value] of Object.entries(entries)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const conversationId = value.continueFrom ?? value.conversationId ?? null;
      const touchedAt =
        typeof value.touchedAt === "number" ? value.touchedAt : Date.now();
      if (
        typeof conversationId !== "string" ||
        conversationId.length === 0 ||
        touchedAt < cutoff
      ) {
        continue;
      }
      this.#chats.set(key, {
        key,
        matchup: null,
        continueFrom: conversationId,
        touchedAt,
      });
    }
  }

  #save() {
    if (!this.#persistPath) {
      return;
    }
    const continuations = {};
    for (const [key, entry] of this.#chats) {
      if (
        typeof entry.continueFrom === "string" &&
        entry.continueFrom.length > 0
      ) {
        continuations[key] = {
          continueFrom: entry.continueFrom,
          touchedAt: entry.touchedAt,
        };
      }
    }

    try {
      mkdirSync(path.dirname(this.#persistPath), { recursive: true });
      const tmp = `${this.#persistPath}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        `${JSON.stringify({ version: 1, continuations }, null, 2)}\n`,
        "utf8",
      );
      renameSync(tmp, this.#persistPath);
    } catch (error) {
      console.warn(
        `[bridge] could not write continuation store ${this.#persistPath}:`,
        error.message ?? error,
      );
    }
  }

  get(key) {
    return this.#entry(key);
  }

  /** Records the matchup a later `!a` / `!b` message will vote on. */
  setMatchup(key, matchup) {
    const entry = this.#entry(key);
    entry.matchup = matchup;
    return entry;
  }

  /** The conversation a follow-up may continue, or `null` when none is ready. */
  peekContinuation(key) {
    return this.#entry(key).continueFrom;
  }

  /**
   * Remembers a conversation only when the vote response said it is safe to
   * continue — `continuable` is authoritative; the bridge does not re-derive
   * left|right ⇒ decisive.
   */
  setContinuation(key, conversationId) {
    const entry = this.#entry(key);
    entry.continueFrom =
      typeof conversationId === "string" && conversationId.length > 0
        ? conversationId
        : null;
    this.#save();
    return entry;
  }

  clearContinuation(key) {
    this.#entry(key).continueFrom = null;
    this.#save();
  }
}

const promptKey = (chatKey, prompt) =>
  `${chatKey}|${createHash("sha256").update(prompt).digest("hex").slice(0, 16)}`;

/**
 * Pairs the two parallel `/v1/chat/completions` requests Open WebUI issues when
 * the user selects `omni-arena-a` and `omni-arena-b` together, so that both are
 * served by *one* Omni-Arena matchup instead of two unrelated ones.
 *
 * This works because Open WebUI v0.10 fans a multi-model turn out into one
 * asyncio task per model (`backend/open_webui/main.py`, "Fan out: one task per
 * model") with identical `messages` and a shared `chat_id`.
 */
export class SlotRendezvous {
  #pending = new Map();
  #timeoutMs;

  constructor({ timeoutMs = 2000 } = {}) {
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Returns `{ round, paired }` for this slot. The first caller parks until its
   * sibling arrives (or the timeout fires); the round itself is started exactly
   * once and shared.
   */
  join(chatKey, prompt, slot, start) {
    const key = promptKey(chatKey, prompt);
    let entry = this.#pending.get(key);

    if (!entry) {
      entry = {
        claimed: new Set(),
        result: deferred(),
        started: false,
        timer: null,
      };
      this.#pending.set(key, entry);
      entry.timer = setTimeout(() => this.#start(key, entry, start), this.#timeoutMs);
      // Never keep the process alive just to wait for a sibling.
      entry.timer.unref?.();
    }

    entry.claimed.add(slot);
    const claimed = entry.claimed;

    if (entry.claimed.size >= 2) {
      this.#start(key, entry, start);
    }

    return entry.result.promise.then((round) => ({
      round,
      paired: claimed.size >= 2,
    }));
  }

  #start(key, entry, start) {
    if (entry.started) {
      return;
    }
    entry.started = true;
    clearTimeout(entry.timer);
    this.#pending.delete(key);
    Promise.resolve()
      .then(start)
      .then(entry.result.resolve, entry.result.reject);
  }
}

/** Convenience wrapper so both rendezvous and duel paths start rounds the same way. */
export const roundStarter = (client, request) => () => startRound(client, request);
