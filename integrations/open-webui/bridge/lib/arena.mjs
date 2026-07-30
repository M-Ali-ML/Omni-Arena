import { Channel, deferred } from "./channel.mjs";

/**
 * Client for the Omni-Arena HTTP API, driving the OpenAI-compatible SSE adapter
 * (`POST /api/arena/chat?protocol=openai`).
 *
 * Note what this class has to do, because it is the finding: even though the
 * adapter emits OpenAI `chat.completion.chunk` frames, the *request* it accepts
 * is Omni-Arena's own `{ prompt }` body at Omni-Arena's own path, and the two
 * slots arrive as `choices[0]` and `choices[1]` of a single completion. No
 * OpenAI-compatible client speaks that. Everything below is the translation
 * layer that has to exist between "OpenAI-shaped frames" and "an OpenAI API".
 */
export class ArenaClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /** Starts a round. `arena: true` opts in when the server runs ARENA_TRIGGER=manual. */
  async chat({ prompt, sessionId, conversationId, arena }) {
    const body = { prompt, sessionId };
    if (conversationId) {
      body.conversationId = conversationId;
    }
    if (arena) {
      body.arena = true;
    }

    const response = await fetch(
      `${this.baseUrl}/api/arena/chat?protocol=openai`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Omni-Arena chat failed: ${response.status} ${detail.slice(0, 500)}`,
      );
    }
    return response;
  }

  async vote({ matchupId, matchupToken, vote }) {
    const response = await fetch(`${this.baseUrl}/api/arena/vote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ matchupId, matchupToken, vote }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? `Vote failed with ${response.status}`);
    }
    return payload;
  }

  /**
   * Rehydrate / verify a stored continuation id. Returns the conversation
   * payload when it still exists for this session, or `null` on 404/403 so
   * the bridge can degrade to a fresh matchup instead of attaching wrongly.
   */
  async getConversation(conversationId, sessionId) {
    if (
      typeof conversationId !== "string" ||
      conversationId.length === 0
    ) {
      return null;
    }
    const url = new URL(
      `${this.baseUrl}/api/arena/conversations/${encodeURIComponent(conversationId)}`,
    );
    if (sessionId) {
      url.searchParams.set("sessionId", sessionId);
    }
    const response = await fetch(url);
    if (response.status === 404 || response.status === 403) {
      return null;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Omni-Arena conversation lookup failed: ${response.status} ${detail.slice(0, 200)}`,
      );
    }
    return response.json();
  }

  async leaderboard() {
    const response = await fetch(`${this.baseUrl}/api/arena/leaderboard`);
    if (!response.ok) {
      throw new Error(`Leaderboard failed with ${response.status}`);
    }
    return response.json();
  }

  async health() {
    const response = await fetch(`${this.baseUrl}/health`);
    return response.ok;
  }
}

const SLOT_BY_INDEX = { 0: "A", 1: "B" };

/** The marker the arena prefixes a failed slot's visible text with. */
const SLOT_ERROR_MARKER = "[omni-arena:slot-error]";

/**
 * Parses the arena's OpenAI-SSE stream back into slot-tagged events.
 *
 * The adapter pins slot A to `choices[0]` of every frame and carries slot B
 * alongside as `choices[1]`, so a frame is a snapshot of both slots: an empty
 * `delta` means "nothing from this slot here", and a finished slot keeps
 * repeating its `finish_reason`, hence the `finished` guard below. The
 * `omni_arena` extension rides only the first chunk, so the matchup token has
 * to be captured there or it is gone; `omni_arena_error` marks a dead slot,
 * which is the only way to tell a failure from the model saying those words.
 */
export async function* parseArenaStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const finished = { A: false, B: false };
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) {
          continue;
        }
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") {
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        if (parsed.error) {
          yield {
            type: "run_error",
            message: parsed.error.message ?? "Arena run failed",
          };
          continue;
        }
        if (parsed.omni_arena) {
          yield { type: "meta", meta: parsed.omni_arena };
        }
        if (parsed.omni_arena_error) {
          yield {
            type: "slot_error",
            slot: parsed.omni_arena_error.slot,
            message: parsed.omni_arena_error.message,
          };
        }
        for (const choice of parsed.choices ?? []) {
          const slot = SLOT_BY_INDEX[choice.index];
          if (!slot) {
            continue;
          }
          const content = choice.delta?.content;
          // The failure already arrived structurally, so its marked text is not
          // repeated into the column's answer.
          if (
            typeof content === "string" &&
            content.length > 0 &&
            !content.includes(SLOT_ERROR_MARKER)
          ) {
            yield { type: "token", slot, token: content };
          }
          if (choice.finish_reason === "stop" && !finished[slot]) {
            finished[slot] = true;
            yield { type: "done", slot };
          }
        }
      }
    }
  }
}

/** Parse the `x-arena-matchup` header the server mirrors onto every chat response. */
export function parseMatchupHeader(value) {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Starts a round and demultiplexes it into one channel per slot plus a promise
 * for the matchup metadata (id + vote token + mode), which the caller needs
 * before it can offer any vote UI. Prefers the `x-arena-matchup` header when
 * present — OpenAI has nowhere clean to put that metadata in-band — and falls
 * back to the `omni_arena` extension on chunk one. `failures` holds each slot's
 * error message, so a renderer can say a column is dead rather than leaving it
 * silently empty.
 */
export async function startRound(client, request) {
  const response = await client.chat(request);
  const channels = { A: new Channel(), B: new Channel() };
  const meta = deferred();
  let metaSettled = false;
  const failures = { A: null, B: null };

  const fromHeader = parseMatchupHeader(response.headers.get("x-arena-matchup"));
  if (fromHeader) {
    metaSettled = true;
    meta.resolve(fromHeader);
  }

  const pump = (async () => {
    try {
      for await (const event of parseArenaStream(response.body)) {
        if (event.type === "meta") {
          // Header already won when present; in-band meta fills the gap otherwise.
          if (!metaSettled) {
            metaSettled = true;
            meta.resolve(event.meta);
          }
        } else if (event.type === "token") {
          channels[event.slot].push(event.token);
        } else if (event.type === "slot_error") {
          failures[event.slot] = event.message;
        } else if (event.type === "run_error") {
          failures.A = failures.B = event.message;
          break;
        } else if (event.type === "done") {
          channels[event.slot].close();
        }
      }
    } catch (error) {
      failures.A = failures.B = error.message ?? String(error);
    } finally {
      if (!metaSettled) {
        meta.resolve(null);
      }
      channels.A.close();
      channels.B.close();
    }
  })();

  return { meta: meta.promise, channels, pump, failures };
}
