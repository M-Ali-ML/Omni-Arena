import http from "node:http";
import { ArenaClient } from "./lib/arena.mjs";
import { MODELS, modelList } from "./lib/models.mjs";
import { CompletionWriter, completionJson } from "./lib/openai.mjs";
import { ChatStore, SlotRendezvous, roundStarter } from "./lib/state.mjs";

/**
 * omni-arena-openai-bridge
 *
 * An OpenAI-compatible façade in front of Omni-Arena, written for this
 * integration because Omni-Arena does not ship one. Omni-Arena has an
 * OpenAI-*framing* adapter (`?protocol=openai`), but no OpenAI *API*: no
 * `GET /v1/models`, no `POST /v1/chat/completions`, and a request body of its
 * own shape. Open WebUI — like every OpenAI-compatible client — needs all
 * three, so this process supplies them and translates in both directions.
 *
 * Everything here is deliberately in the integration directory, not in
 * `server/`. Which parts of it should move upstream is the subject of the
 * "Findings" section of README.md.
 */

const PORT = Number(process.env.BRIDGE_PORT ?? 8080);
const ARENA_BASE_URL = process.env.ARENA_BASE_URL ?? "http://127.0.0.1:3021";
const PAIR_TIMEOUT_MS = Number(process.env.BRIDGE_PAIR_TIMEOUT_MS ?? 2000);
const STATE_PATH =
  process.env.BRIDGE_STATE_PATH ?? "/app/data/continuations.json";
const STATE_TTL_MS = Number(
  process.env.BRIDGE_STATE_TTL_MS ?? 60 * 60 * 1000,
);

const client = new ArenaClient(ARENA_BASE_URL);
const chats = new ChatStore({
  ttlMs: STATE_TTL_MS,
  persistPath: STATE_PATH,
});
const rendezvous = new SlotRendezvous({ timeoutMs: PAIR_TIMEOUT_MS });
/** Dedupes the two identical vote messages a side-by-side turn produces. */
const votesInFlight = new Map();

/**
 * `!` and not `/`. Open WebUI reserves a leading `/` for its own prompt-shortcut
 * menu and simply refuses to send a message that starts with one — verified in
 * the UI, see README, "What does not work". `#` (knowledge) and `@` (model
 * override) are taken too; `!` is free.
 */
const VOTES = new Map(
  Object.entries({
    "!a": "left",
    "!left": "left",
    "vote a": "left",
    "!b": "right",
    "!right": "right",
    "vote b": "right",
    "!tie": "both_good",
    "!both-good": "both_good",
    "!bad": "both_bad",
    "!both-bad": "both_bad",
    "!skip": "skip",
  }),
);

const VOTE_LABEL = {
  left: "A",
  right: "B",
  both_good: "both good",
  both_bad: "both bad",
  skip: "skipped",
};

const VOTE_HINT =
  "Which is better? Send `!a`, `!b`, `!tie`, `!bad` or `!skip` — identities are revealed once you do. `!leaderboard` for standings, `!help` for everything.";

const CONTINUE_HINT =
  "Your next message continues this conversation from the winning answer.";

const HELP = `### Omni-Arena in Open WebUI

**Models**
- \`Omni-Arena · Blind Duel (A + B)\` — one blind matchup, both answers in one message.
- \`Omni-Arena · Anonymous A\` + \`Omni-Arena · Anonymous B\` — select **both** to get Open WebUI's side-by-side view, one arena slot per column.
- \`Omni-Arena · Single Model (no vote)\` — Omni-Arena's \`single\` plan; one answer, nothing to vote on.

**Commands**
| Command | Meaning |
|---|---|
| \`!a\` or \`!left\` | Answer A was better |
| \`!b\` or \`!right\` | Answer B was better |
| \`!tie\` | Both good |
| \`!bad\` | Both bad |
| \`!skip\` | No opinion (not counted) |
| \`!leaderboard\` | Bradley-Terry standings |
| \`!help\` | This message |

Votes are recorded against the last matchup **in this chat**. A decisive vote
(\`!a\` / \`!b\`) lets the next message continue from the winner; \`!tie\` /
\`!bad\` / \`!skip\` start a fresh matchup next turn.
Commands start with \`!\` because Open WebUI reserves \`/\` for its own prompt menu and will not send a message beginning with it.`;

/** Mirror arena matchup metadata so HTTP tests (and arena-aware clients) can read it. */
const matchupHeaders = (meta) =>
  meta
    ? { "x-arena-matchup": JSON.stringify(meta) }
    : {};

/** True when the arena refused a continuation we thought was ready. */
const isContinuationRefusal = (error) =>
  /conversation_not_ready|conversation_not_found|Conversation not found|\b409\b/i.test(
    String(error?.message ?? error),
  );

// ---------------------------------------------------------------- helpers

const textOf = (content) => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" || typeof part?.text === "string")
      .map((part) => part.text ?? "")
      .join("");
  }
  return "";
};

const lastUserPrompt = (messages) => {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return textOf(messages[index].content).trim();
    }
  }
  return "";
};

/**
 * Open WebUI only sends `X-OpenWebUI-Chat-Id` when the deployment enables
 * ENABLE_FORWARD_USER_INFO_HEADERS. Falling back to the user id keeps a
 * single-user demo working; falling back further to a constant is a last
 * resort and is called out in the README as a real limitation.
 */
const chatKeyOf = (headers) =>
  headers["x-openwebui-chat-id"] ??
  headers["x-openwebui-user-id"] ??
  headers["x-arena-chat-id"] ??
  "shared";

const readJson = (request) =>
  new Promise((resolve, reject) => {
    const parts = [];
    request.on("data", (chunk) => parts.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
  });

const sendJson = (response, status, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
};

const drain = async (channel, writer) => {
  let length = 0;
  for await (const token of channel) {
    length += token.length;
    writer.text(token);
  }
  return length;
};

/**
 * A slot that failed. The arena reports this on its `omni_arena_error`
 * extension, so the column can say it is dead instead of being blank or
 * passing the provider's message off as the model's own words.
 */
const failureNote = (round, slot) =>
  round.failures[slot] ? `_This model failed: ${round.failures[slot]}_` : null;

// ---------------------------------------------------------------- renderers

async function renderLeaderboard(writer) {
  writer.start();
  let payload;
  try {
    payload = await client.leaderboard();
  } catch (error) {
    writer.text(`Could not reach Omni-Arena: ${error.message}`);
    writer.finish();
    return;
  }

  const models = payload.models ?? [];
  if (models.length === 0) {
    writer.text("No models on the leaderboard yet.");
    writer.finish();
    return;
  }

  const rows = models.map((model) => {
    const rating =
      model.rating === null || model.rating === undefined
        ? "—"
        : `${Math.round(model.rating)}${
            model.confidenceInterval
              ? ` ±${Math.round(
                  (model.confidenceInterval.upper - model.confidenceInterval.lower) / 2,
                )}`
              : ""
          }`;
    return `| ${model.displayName} | ${rating} | ${(model.winRate * 100).toFixed(0)}% | ${model.wins}/${model.losses}/${model.ties} | ${model.totalVotes} |`;
  });

  writer.text(
    [
      "### Omni-Arena leaderboard",
      "",
      "| Model | Bradley-Terry | Win rate | W/L/T | Votes |",
      "|---|---|---|---|---|",
      ...rows,
      "",
      "_Bradley-Terry ratings appear once the Python rating worker has run at least one fit; until then the win rate is the ranking._",
    ].join("\n"),
  );
  writer.finish();
}

async function renderVote(writer, { chatKey, vote, slot }) {
  writer.start();
  const entry = chats.get(chatKey);
  const matchup = entry.matchup;

  if (!matchup || !matchup.matchupId) {
    writer.text(
      "There is no matchup to vote on in this chat yet. Ask a question first.",
    );
    writer.finish();
    return;
  }
  if (!matchup.votable || !matchup.matchupToken) {
    writer.text(
      "That round was served in `single` mode, so there is nothing to vote on.",
    );
    writer.finish();
    return;
  }

  // A side-by-side turn produces two identical vote messages, one per column,
  // in parallel. They must resolve to the same recorded vote rather than
  // racing each other into a duplicate-vote rejection.
  let recorded = matchup.recorded;
  if (!recorded) {
    const dedupeKey = matchup.matchupId;
    let pending = votesInFlight.get(dedupeKey);
    if (!pending) {
      pending = client
        .vote({
          matchupId: matchup.matchupId,
          matchupToken: matchup.matchupToken,
          vote,
        })
        .then((result) => ({
          vote,
          models: result.models,
          // Server states continuability; do not re-derive from left|right.
          continuable: result.continuable === true,
          conversationId: result.conversationId ?? null,
        }))
        .finally(() => setTimeout(() => votesInFlight.delete(dedupeKey), 30_000));
      votesInFlight.set(dedupeKey, pending);
    }

    try {
      recorded = await pending;
    } catch (error) {
      writer.text(`Vote rejected by Omni-Arena: ${error.message}`);
      writer.finish();
      return;
    }
    entry.matchup = { ...matchup, recorded };
    if (recorded.continuable && recorded.conversationId) {
      chats.setContinuation(chatKey, recorded.conversationId);
    } else {
      chats.clearContinuation(chatKey);
    }
  }

  if (recorded.vote !== vote) {
    writer.text(
      `This round was already scored as **${VOTE_LABEL[recorded.vote]}** — one vote per matchup. Ask another question for a fresh one.\n\n`,
    );
  }

  const nameA = recorded.models?.A?.displayName ?? "unknown";
  const nameB = recorded.models?.B?.displayName ?? "unknown";
  const pick = VOTE_LABEL[recorded.vote];
  const nextStep = recorded.continuable
    ? CONTINUE_HINT
    : "Ask another question for a fresh matchup, or send `!leaderboard`.";

  // In side-by-side mode each column reveals its own slot, which reads far
  // better than repeating the whole reveal twice.
  if (slot === "A" || slot === "B") {
    const own = slot === "A" ? nameA : nameB;
    const won =
      (recorded.vote === "left" && slot === "A") ||
      (recorded.vote === "right" && slot === "B");
    writer.text(
      [
        `**Recorded: ${pick}.**`,
        "",
        `This column was **${own}**${won ? " — your pick. 🏆" : "."}`,
        "",
        `_A: ${nameA} · B: ${nameB}_`,
        "",
        nextStep,
      ].join("\n"),
    );
  } else {
    writer.text(
      [
        `**Recorded: ${pick}.**`,
        "",
        `- **A** was \`${nameA}\``,
        `- **B** was \`${nameB}\``,
        "",
        nextStep,
      ].join("\n"),
    );
  }
  writer.finish();
}

/** Both answers of one matchup, stacked in a single assistant message. */
async function renderDuel(writer, { chatKey, prompt }) {
  const round = await startRoundFor({ chatKey, prompt, arena: true });
  const meta = await round.meta;
  if (meta) {
    chats.setMatchup(chatKey, {
      matchupId: meta.matchupId,
      matchupToken: meta.matchupToken,
      votable: meta.votable,
      mode: meta.mode,
      conversationId: meta.conversationId,
      turnIndex: meta.turnIndex,
    });
    writer.setHeaders(matchupHeaders(meta));
  }

  writer.start();
  writer.text("**Answer A**\n\n");
  const lengthA = await drain(round.channels.A, writer);
  if (lengthA === 0) {
    writer.text(failureNote(round, "A") ?? "_(this slot produced no output)_");
  }
  writer.text("\n\n---\n\n**Answer B**\n\n");
  const lengthB = await drain(round.channels.B, writer);

  if (lengthB === 0) {
    writer.text(failureNote(round, "B") ?? "_(this slot produced no output)_");
  }
  writer.text(`\n\n---\n\n${meta?.votable ? VOTE_HINT : "_This round is not votable._"}`);
  writer.finish();
}

/** One arena slot per Open WebUI column, using its native side-by-side view. */
async function renderSlot(writer, { chatKey, prompt, slot }) {
  const { round, paired } = await rendezvous.join(
    chatKey,
    prompt,
    slot,
    () => startRoundFor({ chatKey, prompt, arena: true }),
  );

  const meta = await round.meta;
  if (meta) {
    chats.setMatchup(chatKey, {
      matchupId: meta.matchupId,
      matchupToken: meta.matchupToken,
      votable: meta.votable,
      mode: meta.mode,
      conversationId: meta.conversationId,
      turnIndex: meta.turnIndex,
    });
    writer.setHeaders(matchupHeaders(meta));
  }

  writer.start();
  if (!paired) {
    writer.text(
      `_Only "${MODELS[`omni-arena-${slot.toLowerCase()}`].name}" was selected, so you are seeing one side of a blind matchup. Select both Anonymous A and Anonymous B in the model picker for the side-by-side comparison._\n\n`,
    );
  }
  const length = await drain(round.channels[slot], writer);
  if (length === 0) {
    writer.text(
      failureNote(round, slot) ?? "_(this slot produced no output)_",
    );
  }
  if (meta?.votable) {
    writer.text(`\n\n---\n\n${VOTE_HINT}`);
  }
  writer.finish();
}

/** Omni-Arena's `single` plan: one model, no matchup, nothing to vote on. */
async function renderSingle(writer, { chatKey, prompt }) {
  // Single rounds are not continuable; leave any pending continuation intact
  // so a later duel in this chat can still pick it up.
  const round = await startRoundFor({ chatKey, prompt, arena: false });
  const meta = await round.meta;
  chats.setMatchup(chatKey, {
    matchupId: meta?.matchupId ?? null,
    // A single round carries no token at all; `null` keeps that explicit.
    matchupToken: meta?.matchupToken ?? null,
    votable: false,
    mode: meta?.mode ?? "single",
  });
  if (meta) {
    writer.setHeaders(matchupHeaders(meta));
  }

  writer.start();
  await drain(round.channels.A, writer);
  writer.finish();
}

/**
 * Omni-Arena's own openai-sse output, forwarded byte-for-byte.
 *
 * This is what "just point Open WebUI at the adapter" would look like if the
 * adapter were reachable at an OpenAI path, and it is here to be *seen* to fail:
 * the frames are valid OpenAI chunks, slot B really is on the wire as
 * `choices[1]`, and Open WebUI still renders only one answer.
 */
async function renderRaw(response, { chatKey, prompt }) {
  const upstream = await client.chat({ prompt, sessionId: chatKey, arena: true });
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const reader = upstream.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    response.write(Buffer.from(value));
  }
  response.end();
}

/**
 * Starts a round, attaching a pending continuation when one exists for this
 * chat. After a bridge restart the id is reloaded from the durable store; we
 * still confirm via GET /api/arena/conversations/:id that it is continuable
 * for this session. A miss (404/403), expired/non-continuable thread, or a
 * refusal from the server clears the mapping and retries as a fresh matchup —
 * wrong-thread attachment is never acceptable.
 */
async function resolveContinuation(chatKey) {
  const conversationId = chats.peekContinuation(chatKey);
  if (!conversationId) {
    return undefined;
  }
  try {
    const thread = await client.getConversation(conversationId, chatKey);
    if (!thread || thread.continuable !== true) {
      chats.clearContinuation(chatKey);
      return undefined;
    }
    return conversationId;
  } catch (error) {
    // Transient lookup failures should not invent a new thread while we still
    // hold a durable id — fall through and let the chat request decide.
    console.warn(
      `[bridge] continuation lookup failed for ${conversationId}:`,
      error.message ?? error,
    );
    return conversationId;
  }
}

async function startRoundFor({ chatKey, prompt, arena }) {
  const conversationId = arena
    ? await resolveContinuation(chatKey)
    : undefined;
  try {
    const round = await roundStarter(client, {
      prompt,
      sessionId: chatKey,
      conversationId,
      arena,
    })();
    // Consumed once the server accepted the request; the next turn needs a
    // fresh decisive vote before it may continue again.
    if (conversationId) {
      chats.clearContinuation(chatKey);
    }
    return round;
  } catch (error) {
    if (conversationId && isContinuationRefusal(error)) {
      chats.clearContinuation(chatKey);
      return roundStarter(client, { prompt, sessionId: chatKey, arena })();
    }
    throw error;
  }
}

// ---------------------------------------------------------------- routing

async function handleChatCompletion(request, response) {
  const body = await readJson(request);
  const modelId = body.model;
  const spec = MODELS[modelId];

  if (!spec) {
    sendJson(response, 404, {
      error: { message: `Unknown model '${modelId}'`, type: "invalid_request_error" },
    });
    return;
  }

  const chatKey = chatKeyOf(request.headers);
  const prompt = lastUserPrompt(body.messages);
  console.log(
    `[bridge] ${modelId} stream=${body.stream === true} chat=${chatKey.slice(0, 8)} prompt=${JSON.stringify(prompt.slice(0, 60))}`,
  );

  // Open WebUI's title/tag/follow-up helpers post non-streaming completions
  // with their own instruction prompts. Running a matchup for those would
  // burn a comparison and poison the leaderboard, so they get a canned answer.
  if (body.stream !== true) {
    sendJson(
      response,
      200,
      completionJson(modelId, JSON.stringify({ title: "Arena round" })),
    );
    return;
  }

  if (spec.kind === "raw") {
    await renderRaw(response, { chatKey, prompt });
    return;
  }

  const writer = new CompletionWriter(response, modelId);

  try {
    if (prompt === "") {
      writer.start();
      writer.text("Empty prompt.");
      writer.finish();
      return;
    }

    const command = prompt.toLowerCase();
    if (command === "!help") {
      writer.start();
      writer.text(HELP);
      writer.finish();
      return;
    }
    if (command === "!leaderboard") {
      await renderLeaderboard(writer);
      return;
    }
    const vote = VOTES.get(command);
    if (vote) {
      await renderVote(writer, { chatKey, vote, slot: spec.slot });
      return;
    }

    if (spec.kind === "duel") {
      await renderDuel(writer, { chatKey, prompt });
    } else if (spec.kind === "slot") {
      await renderSlot(writer, { chatKey, prompt, slot: spec.slot });
    } else {
      await renderSingle(writer, { chatKey, prompt });
    }
  } catch (error) {
    console.error("[bridge] request failed:", error);
    if (writer.closed) {
      return;
    }
    if (!response.headersSent) {
      sendJson(response, 502, {
        error: { message: String(error?.message ?? error), type: "api_error" },
      });
      return;
    }
    writer.text(`\n\n**Omni-Arena error:** ${error.message}`);
    writer.finish();
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://bridge");

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok", arena: ARENA_BASE_URL });
    return;
  }
  if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    sendJson(response, 200, modelList());
    return;
  }
  if (
    request.method === "POST" &&
    (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")
  ) {
    handleChatCompletion(request, response).catch((error) => {
      console.error("[bridge] unhandled:", error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: { message: String(error) } });
      }
    });
    return;
  }

  sendJson(response, 404, { error: { message: `No route for ${request.method} ${url.pathname}` } });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[bridge] OpenAI-compatible surface on :${PORT} -> Omni-Arena at ${ARENA_BASE_URL}`,
  );
  console.log(`[bridge] continuation store: ${STATE_PATH}`);
});
