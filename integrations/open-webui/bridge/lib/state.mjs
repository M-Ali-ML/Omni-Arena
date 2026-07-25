import { createHash } from "node:crypto";
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
 */
export class ChatStore {
  #chats = new Map();
  #ttlMs;

  constructor({ ttlMs = 60 * 60 * 1000 } = {}) {
    this.#ttlMs = ttlMs;
  }

  #entry(key) {
    this.#sweep();
    let entry = this.#chats.get(key);
    if (!entry) {
      entry = { key, matchup: null, touchedAt: Date.now() };
      this.#chats.set(key, entry);
    }
    entry.touchedAt = Date.now();
    return entry;
  }

  #sweep() {
    const cutoff = Date.now() - this.#ttlMs;
    for (const [key, entry] of this.#chats) {
      if (entry.touchedAt < cutoff) {
        this.#chats.delete(key);
      }
    }
  }

  get(key) {
    return this.#entry(key);
  }

  /** Records the matchup a later `/a` or `/b` message will vote on. */
  setMatchup(key, matchup) {
    const entry = this.#entry(key);
    entry.matchup = matchup;
    return entry;
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
