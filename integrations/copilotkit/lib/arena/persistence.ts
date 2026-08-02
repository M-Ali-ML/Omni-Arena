/**
 * Survives a reload so the conversation GET can rebuild the thread and a
 * still-open round can still be voted on. The conversation endpoint never
 * returns `matchupToken` (that would let anyone with a matchup id vote), so
 * the token has to live client-side for the span between stream and vote.
 *
 * CopilotKit mints a fresh `threadId` per mount unless we pin one here — the
 * matchup-cache poll key and the AG-UI thread echo both depend on it.
 */
const STORAGE_KEY = "omni-arena.copilotkit";

export type PersistedArena = {
  threadId: string | null;
  conversationId: string | null;
  /** Tokens keyed by matchup id — only needed while a round is still votable. */
  tokens: Record<string, string>;
};

const EMPTY: PersistedArena = {
  threadId: null,
  conversationId: null,
  tokens: {},
};

export function readPersistedArena(): PersistedArena {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<PersistedArena>;
    return {
      threadId: typeof parsed.threadId === "string" ? parsed.threadId : null,
      conversationId:
        typeof parsed.conversationId === "string" ? parsed.conversationId : null,
      tokens:
        parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : {},
    };
  } catch {
    return EMPTY;
  }
}

function writePersistedArena(next: PersistedArena): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function persistThreadId(threadId: string): void {
  const current = readPersistedArena();
  writePersistedArena({ ...current, threadId });
}

export function persistConversationId(conversationId: string | null): void {
  const current = readPersistedArena();
  writePersistedArena({ ...current, conversationId });
}

export function persistMatchupToken(
  matchupId: string,
  matchupToken: string | undefined,
): void {
  const current = readPersistedArena();
  const tokens = { ...current.tokens };
  if (matchupToken) {
    tokens[matchupId] = matchupToken;
  } else {
    delete tokens[matchupId];
  }
  writePersistedArena({ ...current, tokens });
}

export function clearPersistedArena(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}
