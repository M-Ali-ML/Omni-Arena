/** Where the anonymous session id is persisted by default. */
export const ARENA_SESSION_STORAGE_KEY = "omni-arena-session";

export interface GetSessionIdOptions {
  key?: string;
  prefix?: string;
  /**
   * Where to persist the id. Defaults to `localStorage` when it is reachable;
   * pass `null` — or simply call this from a server route, where there is none —
   * to get a one-off id that is not stored anywhere.
   */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    // Node exposes an experimental global `localStorage` getter that resolves to
    // undefined, so the property may exist and still be unusable.
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function randomId(): string {
  const source = (globalThis as { crypto?: Crypto }).crypto;
  return typeof source?.randomUUID === "function"
    ? source.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The anonymous session id the arena ties conversation ownership to: a
 * follow-up turn must present the same one that started the conversation.
 *
 * Stable per browser (persisted under `omni-arena-session`) and safe to call
 * where no storage exists, in which case each call mints a fresh id.
 */
export function getSessionId(options: GetSessionIdOptions = {}): string {
  const { key = ARENA_SESSION_STORAGE_KEY, prefix = "anon_" } = options;
  const storage =
    options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) {
    return `${prefix}${randomId()}`;
  }
  try {
    const existing = storage.getItem(key);
    if (existing) {
      return existing;
    }
    const created = `${prefix}${randomId()}`;
    storage.setItem(key, created);
    return created;
  } catch {
    // Blocked storage (private browsing, disabled cookies) still gets a working
    // id for this call, just not a durable one.
    return `${prefix}${randomId()}`;
  }
}
