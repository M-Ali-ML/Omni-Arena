#!/usr/bin/env node
/**
 * HTTP-level verification of the OpenAI-compatible surface Open WebUI consumes.
 *
 * This is the test that matters for this integration: it asserts the exact
 * contract Open WebUI relies on — `GET /v1/models`, a streaming
 * `POST /v1/chat/completions` whose frames are well-formed
 * `chat.completion.chunk` objects with content on `choices[0]` and a trailing
 * `[DONE]` — and then the arena semantics layered on top: two anonymous
 * answers, a vote, and the reveal.
 *
 * It runs inside the bridge container (`npm run test:http`), because the bridge
 * has no host port: the integration is limited to three of them.
 */
const BASE = process.env.BRIDGE_URL ?? "http://127.0.0.1:8080";
const CHAT = (suffix) => `test-chat-${suffix}-${Date.now()}`;

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

const section = (name) => console.log(`\n${name}`);

/**
 * The mock provider opens every answer with `Mock answer, variant <tag>`, where
 * the tag is a neutral per-model fingerprint (`server/src/providers/mock.ts`).
 * It names no model — blindness — while still telling two slots apart, so it is
 * what these checks compare instead of the display names they used to read.
 */
const variantsIn = (text) =>
  new Set(
    [...text.matchAll(/Mock answer, variant ([0-9a-f]{4})/g)].map(
      (match) => match[1],
    ),
  );

/**
 * Reads a streaming completion the way a strict OpenAI client would, and
 * reports both the assembled text and every conformance problem seen.
 */
async function readCompletion(response) {
  const problems = [];
  // Multiple choices in one frame is legal (`n > 1`) but only ever read
  // positionally, so it is counted rather than treated as a defect.
  let multiChoiceFrames = 0;
  const matchupHeader = response.headers.get("x-arena-matchup");
  let matchup = null;
  if (matchupHeader) {
    try {
      matchup = JSON.parse(matchupHeader);
    } catch {
      problems.push("unparseable x-arena-matchup header");
    }
  }
  if (!response.ok) {
    problems.push(`status ${response.status}`);
    return {
      text: "",
      problems,
      frames: 0,
      sawDone: false,
      chunks: [],
      multiChoiceFrames,
      matchup,
    };
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    problems.push(`content-type ${contentType}`);
  }

  const chunks = [];
  let text = "";
  let frames = 0;
  let sawDone = false;
  let buffer = "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (!frame.startsWith("data:")) {
        if (frame) problems.push(`non-data frame: ${frame.slice(0, 40)}`);
        continue;
      }
      const payload = frame.slice(5).trim();
      if (payload === "[DONE]") {
        sawDone = true;
        continue;
      }
      frames += 1;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        problems.push(`unparseable frame: ${payload.slice(0, 60)}`);
        continue;
      }
      chunks.push(parsed);
      if (parsed.object !== "chat.completion.chunk") {
        problems.push(`object=${parsed.object}`);
      }
      if (!Array.isArray(parsed.choices)) {
        problems.push("missing choices");
        continue;
      }
      if (parsed.choices.length !== 1) {
        multiChoiceFrames += 1;
      }
      text += parsed.choices[0]?.delta?.content ?? "";
    }
  }
  return { text, problems, frames, sawDone, chunks, multiChoiceFrames, matchup };
}

const complete = (model, prompt, chatId, extra = {}) =>
  fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer omni-arena-demo",
      "x-openwebui-chat-id": chatId,
      ...(extra.headers ?? {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      ...(extra.body ?? {}),
    }),
  });

// ------------------------------------------------------------------ 1. models

section("GET /v1/models (Open WebUI's connection check and model list)");
{
  const response = await fetch(`${BASE}/v1/models`);
  check("responds 200", response.status === 200, `got ${response.status}`);
  const payload = await response.json();
  check("object is 'list'", payload.object === "list");
  const ids = (payload.data ?? []).map((model) => model.id);
  for (const id of [
    "omni-arena-duel",
    "omni-arena-a",
    "omni-arena-b",
    "omni-arena-single",
    "omni-arena-raw",
  ]) {
    check(`advertises ${id}`, ids.includes(id), ids.join(", "));
  }
  check(
    "every entry has object='model' and owned_by",
    (payload.data ?? []).every((m) => m.object === "model" && m.owned_by),
  );
}

// -------------------------------------------------------------- 2. blind duel

section("Blind duel — both anonymous answers in one OpenAI stream");
const duelChat = CHAT("duel");
{
  const result = await readCompletion(
    await complete("omni-arena-duel", "What is a vector database?", duelChat),
  );
  check("stream is OpenAI-conformant", result.problems.length === 0, result.problems.join("; "));
  check("terminated with [DONE]", result.sawDone);
  check("streamed more than one frame", result.frames > 2, `${result.frames} frames`);
  check("labels answer A", result.text.includes("**Answer A**"));
  check("labels answer B", result.text.includes("**Answer B**"));
  check(
    "carries two distinct model outputs",
    variantsIn(result.text).size === 2,
    result.text.slice(0, 200),
  );
  check("offers the vote commands", result.text.includes("!a"));
  check(
    "reveals no identity before the vote is cast",
    !/Answer A\*\*\s*\n\n(?:.*)(revealed|identity)/i.test(result.text) &&
      !/Mock Model|mock-(alpha|beta)/.test(result.text),
  );
}

section("Vote and reveal");
{
  const result = await readCompletion(await complete("omni-arena-duel", "!a", duelChat));
  check("vote is accepted", result.text.includes("Recorded"), result.text.slice(0, 200));
  check(
    "reveals both identities",
    result.text.includes("Mock Model Alpha") && result.text.includes("Mock Model Beta"),
    result.text.slice(0, 200),
  );
}

section("A second, different vote on the same matchup does not double-count");
{
  const result = await readCompletion(await complete("omni-arena-duel", "!b", duelChat));
  check(
    "the earlier vote stands",
    /already scored as \*\*A\*\*/i.test(result.text),
    result.text.slice(0, 200),
  );
}

// ------------------------------------------- 2b. multi-turn continuation

section("Multi-turn — a decisive vote continues the same conversation");
{
  const chat = CHAT("continue");
  const turn0 = await readCompletion(
    await complete("omni-arena-duel", "What is Redis?", chat),
  );
  check(
    "turn 0 carries a conversation id",
    typeof turn0.matchup?.conversationId === "string",
    JSON.stringify(turn0.matchup),
  );
  check(
    "turn 0 is the first turn",
    turn0.matchup?.turnIndex === 0,
    JSON.stringify(turn0.matchup),
  );

  const vote = await readCompletion(await complete("omni-arena-duel", "!a", chat));
  check("decisive vote is accepted", vote.text.includes("Recorded"), vote.text.slice(0, 160));
  check(
    "reveal offers continuation",
    /continues this conversation from the winning answer/i.test(vote.text),
    vote.text.slice(0, 240),
  );

  const turn1 = await readCompletion(
    await complete("omni-arena-duel", "How does persistence work?", chat),
  );
  check(
    "turn 1 stays on the same conversation",
    turn1.matchup?.conversationId === turn0.matchup?.conversationId,
    `turn0=${turn0.matchup?.conversationId} turn1=${turn1.matchup?.conversationId}`,
  );
  check(
    "turn 1 advances the turn index",
    turn1.matchup?.turnIndex === 1,
    JSON.stringify(turn1.matchup),
  );
  check(
    "turn 1 still streams two anonymous answers",
    variantsIn(turn1.text).size === 2 && turn1.text.includes("**Answer A**"),
    turn1.text.slice(0, 200),
  );
}

section("Multi-turn — a non-decisive vote starts a fresh conversation next turn");
{
  const chat = CHAT("tie");
  const turn0 = await readCompletion(
    await complete("omni-arena-duel", "Compare TCP and UDP.", chat),
  );
  const vote = await readCompletion(await complete("omni-arena-duel", "!tie", chat));
  check("tie is accepted", vote.text.includes("Recorded"), vote.text.slice(0, 160));
  check(
    "tie does not offer continuation",
    !/continues this conversation/i.test(vote.text),
    vote.text.slice(0, 240),
  );

  const turn1 = await readCompletion(
    await complete("omni-arena-duel", "What about SCTP?", chat),
  );
  check(
    "the follow-up is a new conversation",
    typeof turn1.matchup?.conversationId === "string" &&
      turn1.matchup.conversationId !== turn0.matchup?.conversationId,
    `turn0=${turn0.matchup?.conversationId} turn1=${turn1.matchup?.conversationId}`,
  );
  check(
    "the new conversation starts at turn 0",
    turn1.matchup?.turnIndex === 0,
    JSON.stringify(turn1.matchup),
  );
}

section("Multi-turn — without a vote, a follow-up is a new matchup");
{
  const chat = CHAT("novote");
  const turn0 = await readCompletion(
    await complete("omni-arena-duel", "What is a bloom filter?", chat),
  );
  const turn1 = await readCompletion(
    await complete("omni-arena-duel", "And a cuckoo filter?", chat),
  );
  check(
    "an unvoted follow-up does not reuse the conversation",
    typeof turn1.matchup?.conversationId === "string" &&
      turn1.matchup.conversationId !== turn0.matchup?.conversationId,
    `turn0=${turn0.matchup?.conversationId} turn1=${turn1.matchup?.conversationId}`,
  );
}

// --------------------------------------------------- 3. side-by-side pairing

section("Side-by-side — two parallel requests joined into ONE matchup");
const pairChat = CHAT("pair");
{
  const prompt = "Explain HTTP/3 in two sentences.";
  const [a, b] = await Promise.all([
    complete("omni-arena-a", prompt, pairChat).then(readCompletion),
    complete("omni-arena-b", prompt, pairChat).then(readCompletion),
  ]);

  check("slot A stream is conformant", a.problems.length === 0, a.problems.join("; "));
  check("slot B stream is conformant", b.problems.length === 0, b.problems.join("; "));
  check("both columns produced text", a.text.length > 40 && b.text.length > 40);
  const [columnA] = variantsIn(a.text);
  const [columnB] = variantsIn(b.text);
  check(
    "the two columns are different models",
    columnA !== undefined && columnB !== undefined && columnA !== columnB,
    `A=${a.text.slice(0, 60)} | B=${b.text.slice(0, 60)}`,
  );
  check(
    "neither column announces it is a lone slot",
    !a.text.includes("Only ") && !b.text.includes("Only "),
    "rendezvous did not pair the two requests",
  );

  // One matchup, so voting once must resolve both columns consistently.
  const [voteA, voteB] = await Promise.all([
    complete("omni-arena-a", "!b", pairChat).then(readCompletion),
    complete("omni-arena-b", "!b", pairChat).then(readCompletion),
  ]);
  check("both columns accept the single vote", voteA.text.includes("Recorded") && voteB.text.includes("Recorded"));
  check(
    "each column reveals its own slot",
    voteA.text.includes("This column was") && voteB.text.includes("This column was"),
    voteA.text.slice(0, 120),
  );
  check(
    "the winning column is marked",
    voteB.text.includes("your pick") && !voteA.text.includes("your pick"),
    `A=${voteA.text.slice(0, 120)}`,
  );
}

// ------------------------------------------------------------- 4. single mode

section("Single mode — Omni-Arena's `single` plan through the same surface");
const singleChat = CHAT("single");
{
  const result = await readCompletion(
    await complete("omni-arena-single", "Name three primes.", singleChat),
  );
  check("stream is conformant", result.problems.length === 0, result.problems.join("; "));
  check("produced one answer", result.text.length > 40);
  check("offers no vote", !result.text.includes("!tie"), result.text.slice(-120));

  const vote = await readCompletion(await complete("omni-arena-single", "!a", singleChat));
  check(
    "voting on a single round is refused",
    /nothing to vote|single/i.test(vote.text),
    vote.text.slice(0, 160),
  );
}

// ------------------------------------- 4b. the adapter gap, demonstrated

section("Raw openai-sse passthrough — one coherent answer on choices[0]");
{
  const response = await complete(
    "omni-arena-raw",
    "Compare TCP and UDP.",
    CHAT("raw"),
  );
  const result = await readCompletion(response);

  // Omni-Arena used to emit one choice per frame with the slot in `index`,
  // which every positional `choices[0]` reader — Open WebUI's SvelteKit parser
  // and its Python middleware both — spliced into one incoherent message at
  // HTTP 200. The adapter now pins slot A to `choices[0]` of every frame.
  const contentFrames = result.chunks.filter((chunk) =>
    (chunk.choices ?? []).some((choice) => typeof choice.delta?.content === "string"),
  );
  check(
    "slot A is always at position 0",
    result.chunks.every((chunk) => chunk.choices[0]?.index === 0),
  );
  check(
    "slot B rides choices[1] of the same frame",
    contentFrames.some((chunk) => chunk.choices[1]?.index === 1),
  );

  // What a positional reader ends up with: exactly one of the two models,
  // start to finish, instead of both interleaved.
  check(
    "a positional reader gets exactly one model's answer",
    variantsIn(result.text).size === 1,
    result.text.slice(0, 160),
  );
  check("that answer is complete", result.text.includes("You said:"), result.text.slice(0, 160));

  const slotB = contentFrames
    .map((chunk) => chunk.choices[1]?.delta?.content ?? "")
    .join("");
  check("slot B is still recoverable by index", slotB.length > 40, slotB.slice(0, 80));
  const [position0] = variantsIn(result.text);
  const [position1] = variantsIn(slotB);
  check(
    "the two positions carry different models",
    position0 !== undefined && position1 !== undefined && position0 !== position1,
    `0=${result.text.slice(0, 60)} | 1=${slotB.slice(0, 60)}`,
  );

  check(
    "still a well-formed stream: HTTP 200, valid chunks, [DONE]",
    response.status === 200 &&
      result.sawDone &&
      result.chunks.every((chunk) => chunk.object === "chat.completion.chunk"),
  );
  check(
    "the matchup extension carries the conversation for multi-turn",
    typeof result.chunks[0]?.omni_arena?.conversationId === "string" &&
      typeof result.chunks[0]?.omni_arena?.turnIndex === "number",
    JSON.stringify(result.chunks[0]?.omni_arena ?? null),
  );
}

// -------------------------------------------------------------- 5. leaderboard

section("Leaderboard reflects the recorded votes");
{
  const result = await readCompletion(
    await complete("omni-arena-duel", "!leaderboard", CHAT("board")),
  );
  check("renders a table", result.text.includes("| Model |"), result.text.slice(0, 160));
  check(
    "lists the seeded roster",
    result.text.includes("Mock Model Alpha") && result.text.includes("Mock Model Beta"),
  );
}

// ------------------------------------------------- 6. non-streaming behaviour

section("Non-streaming requests (Open WebUI's title/tag helpers) never start a matchup");
{
  const response = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openwebui-chat-id": CHAT("task") },
    body: JSON.stringify({
      model: "omni-arena-duel",
      messages: [{ role: "user", content: "### Task:\nGenerate a title" }],
      stream: false,
    }),
  });
  const payload = await response.json();
  check("answers with a chat.completion", payload.object === "chat.completion");
  check("has one choice with a message", payload.choices?.[0]?.message?.role === "assistant");
}

section("Unknown model");
{
  const response = await complete("gpt-4o", "hello", CHAT("unknown"));
  check("404s like the OpenAI API", response.status === 404, `got ${response.status}`);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
