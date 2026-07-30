#!/usr/bin/env node
/**
 * Proves multi-turn continuation survives a bridge container restart.
 *
 * Orchestrated from the host (the bridge has no published port): duel + vote
 * inside the container, `docker compose restart bridge`, then the follow-up
 * inside the restarted container. The durable JSON store on `./.data/bridge`
 * is what carries the conversationId across the process boundary.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const run = (args, { allowFail = false } = {}) => {
  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!allowFail && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").slice(0, 800);
    throw new Error(`docker ${args.join(" ")} failed (${result.status}): ${detail}`);
  }
  return result;
};

const bridgeNode = (source) => {
  const result = run([
    "compose",
    "exec",
    "-T",
    "bridge",
    "node",
    "--input-type=module",
    "-e",
    source,
  ]);
  return result.stdout.trim();
};

const waitHealthy = async (attempts = 40) => {
  for (let i = 0; i < attempts; i += 1) {
    const result = run(
      [
        "compose",
        "exec",
        "-T",
        "bridge",
        "node",
        "-e",
        "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ],
      { allowFail: true },
    );
    if (result.status === 0) {
      return;
    }
    await sleep(500);
  }
  throw new Error("bridge did not become healthy after restart");
};

const chatId = `restart-chat-${Date.now()}`;

console.log("\nContinuation across bridge restart");
console.log(`  chat ${chatId}`);

const prepareSource = `
const BASE = "http://127.0.0.1:8080";
const chatId = ${JSON.stringify(chatId)};

async function readCompletion(response) {
  const matchupHeader = response.headers.get("x-arena-matchup");
  let matchup = null;
  if (matchupHeader) matchup = JSON.parse(matchupHeader);
  let text = "";
  let buffer = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\\n\\n")) !== -1) {
      const frame = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (!frame.startsWith("data:")) continue;
      const payload = frame.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      const parsed = JSON.parse(payload);
      text += parsed.choices?.[0]?.delta?.content ?? "";
    }
  }
  return { text, matchup };
}

const complete = (prompt) =>
  fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openwebui-chat-id": chatId,
    },
    body: JSON.stringify({
      model: "omni-arena-duel",
      messages: [{ role: "user", content: prompt }],
      stream: true,
    }),
  });

const turn0 = await readCompletion(await complete("What is a WAL?"));
const vote = await readCompletion(await complete("!a"));
if (!turn0.matchup?.conversationId) {
  console.error(JSON.stringify({ error: "no conversationId", turn0, vote }));
  process.exit(2);
}
if (!/Recorded/i.test(vote.text)) {
  console.error(JSON.stringify({ error: "vote failed", vote: vote.text.slice(0, 200) }));
  process.exit(3);
}
process.stdout.write(JSON.stringify({
  conversationId: turn0.matchup.conversationId,
  turnIndex: turn0.matchup.turnIndex,
  voteOk: true,
}));
`;

let prepared;
try {
  prepared = JSON.parse(bridgeNode(prepareSource));
} catch (error) {
  console.error(error);
  process.exit(1);
}

check(
  "turn 0 produced a conversation id before restart",
  typeof prepared.conversationId === "string",
  JSON.stringify(prepared),
);
check("decisive vote recorded before restart", prepared.voteOk === true);

console.log("  … restarting bridge container");
run(["compose", "restart", "bridge"]);
await waitHealthy();
check("bridge healthy after restart", true);

const continueSource = `
const BASE = "http://127.0.0.1:8080";
const chatId = ${JSON.stringify(chatId)};
const expected = ${JSON.stringify(prepared.conversationId)};

async function readCompletion(response) {
  const matchupHeader = response.headers.get("x-arena-matchup");
  let matchup = null;
  if (matchupHeader) matchup = JSON.parse(matchupHeader);
  let text = "";
  let buffer = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\\n\\n")) !== -1) {
      const frame = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (!frame.startsWith("data:")) continue;
      const payload = frame.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      const parsed = JSON.parse(payload);
      text += parsed.choices?.[0]?.delta?.content ?? "";
    }
  }
  return { text, matchup };
}

const response = await fetch(BASE + "/v1/chat/completions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-openwebui-chat-id": chatId,
  },
  body: JSON.stringify({
    model: "omni-arena-duel",
    messages: [{ role: "user", content: "How does checkpointing interact with it?" }],
    stream: true,
  }),
});
const turn1 = await readCompletion(response);
process.stdout.write(JSON.stringify({
  conversationId: turn1.matchup?.conversationId ?? null,
  turnIndex: turn1.matchup?.turnIndex ?? null,
  same: turn1.matchup?.conversationId === expected,
  textSample: (turn1.text ?? "").slice(0, 120),
}));
`;

let continued;
try {
  continued = JSON.parse(bridgeNode(continueSource));
} catch (error) {
  console.error(error);
  process.exit(1);
}

check(
  "follow-up after restart stays on the same conversation",
  continued.same === true,
  `before=${prepared.conversationId} after=${continued.conversationId}`,
);
check(
  "follow-up after restart advances to turn 1",
  continued.turnIndex === 1,
  JSON.stringify(continued),
);

console.log(
  `\n${passes} passed, ${failures} failed (continuation restart)`,
);
process.exit(failures === 0 ? 0 : 1);
