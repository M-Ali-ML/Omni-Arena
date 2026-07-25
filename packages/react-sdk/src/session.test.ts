import { describe, expect, it } from "vitest";
import { ARENA_SESSION_STORAGE_KEY, getSessionId } from "./session.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & {
  entries: Map<string, string>;
} {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
  };
}

describe("getSessionId", () => {
  it("persists one id and reuses it", () => {
    const storage = memoryStorage();

    const first = getSessionId({ storage });
    const second = getSessionId({ storage });

    expect(first).toMatch(/^anon_/);
    expect(second).toBe(first);
    expect(storage.entries.get(ARENA_SESSION_STORAGE_KEY)).toBe(first);
  });

  it("honours a custom key and prefix", () => {
    const storage = memoryStorage();

    const id = getSessionId({ storage, key: "arena.session", prefix: "host-" });

    expect(id).toMatch(/^host-/);
    expect(storage.entries.get("arena.session")).toBe(id);
  });

  it("mints an unpersisted id where there is no storage", () => {
    const first = getSessionId({ storage: null });
    const second = getSessionId({ storage: null });

    expect(first).toMatch(/^anon_/);
    expect(second).not.toBe(first);
  });

  it("still returns an id when storage throws", () => {
    const id = getSessionId({
      storage: {
        getItem: () => {
          throw new Error("Storage disabled");
        },
        setItem: () => {
          throw new Error("Storage disabled");
        },
      },
    });

    expect(id).toMatch(/^anon_/);
  });
});
