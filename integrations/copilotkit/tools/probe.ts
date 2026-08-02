/**
 * Headless end-to-end proof — no browser.
 *
 * Drives the same `ArenaHttpAgent` the CopilotRuntime registers against
 * OmniArena's AG-UI endpoint, then votes and continues. The CopilotKit
 * runtime HTTP envelope is impractical to call headlessly; this probe
 * exercises the load-bearing agent + header-capture path instead. Playwright
 * (Increment 2) covers the full browser poll of `GET /api/arena/matchup`.
 *
 *   npm run arena   # terminal 1
 *   npm run probe   # terminal 2
 */
import { ArenaHttpAgent } from "../lib/arena/agent.js";
import { matchupCache } from "../lib/arena/matchup-cache.js";

const arenaUrl = (process.env.ARENA_URL ?? "http://127.0.0.1:3031").replace(
  /\/$/,
  "",
);
const appUrl = process.env.APP_URL?.replace(/\/$/, "");

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function summarize(): void {
  const failed = checks.filter((c) => !c.ok);
  console.log("\n────────────────────────────────");
  if (failed.length === 0) {
    console.log(`PASS — ${checks.length}/${checks.length} checks`);
    process.exit(0);
  }
  console.log(`FAIL — ${failed.length}/${checks.length} checks failed:`);
  for (const f of failed) {
    console.log(`  • ${f.name}${f.detail ? `: ${f.detail}` : ""}`);
  }
  process.exit(1);
}

const THREAD = "probe-thread";
const starts: string[] = [];
const eventTypes: string[] = [];
let customMatchup: unknown;

console.log(`\nProbe → ${arenaUrl} (AG-UI)`);
console.log("1. First turn (arena on)…");

const agent = new ArenaHttpAgent(
  {
    arenaEnabled: true,
    conversationId: null,
    sessionId: "copilotkit-probe",
  },
  {
    url: `${arenaUrl}/api/arena/chat?protocol=ag-ui`,
    threadId: THREAD,
  },
);

agent.subscribe({
  onEvent: ({ event }) => {
    const typed = event as { type?: string; messageId?: string };
    if (typed.type) eventTypes.push(typed.type);
    if (typed.type === "TEXT_MESSAGE_START" && typed.messageId) {
      starts.push(typed.messageId);
    }
  },
  onCustomEvent: ({ event }) => {
    const typed = event as { name?: string; value?: unknown };
    if (typed.name === "arena_matchup") customMatchup = typed.value;
  },
});

agent.messages = [
  { id: "u1", role: "user", content: "probe the arena via CopilotKit agent" },
];

const result = await agent.runAgent({
  threadId: THREAD,
  runId: "probe-run-1",
});

const captured = matchupCache.get(THREAD);

check(
  "RUN reaches FINISHED",
  eventTypes.includes("RUN_FINISHED"),
  eventTypes.slice(-3).join(" → "),
);
check(
  "two slot TEXT_MESSAGE_START ids",
  starts.length === 2 &&
    starts.every((id) => id.endsWith(":A") || id.endsWith(":B")),
  starts.join(", "),
);
check(
  "both slots in newMessages",
  result.newMessages.filter((m) => m.role === "assistant").length >= 2,
  `${result.newMessages.length} new message(s)`,
);
check(
  "x-arena-matchup header → matchupCache",
  Boolean(captured?.matchupToken && captured.matchupId),
  captured
    ? `matchupId=${captured.matchupId} turnIndex=${captured.turnIndex}`
    : "missing",
);
check(
  "CUSTOM arena_matchup also present on wire",
  Boolean(customMatchup),
  customMatchup ? "yes (agent subscribe)" : "absent",
);

if (!captured?.matchupToken || !captured.matchupId) {
  console.error("\nFAIL: cannot vote without matchup token");
  summarize();
}

console.log("2. Vote (left)…");

const voteUrl = appUrl
  ? `${appUrl}/api/arena/vote`
  : `${arenaUrl}/api/arena/vote`;
const voteResponse = await fetch(voteUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    matchupId: captured.matchupId,
    matchupToken: captured.matchupToken,
    vote: "left",
  }),
});
const votePayload = (await voteResponse.json()) as {
  accepted?: boolean;
  continuable?: boolean;
  conversationId?: string;
  models?: { A?: { displayName?: string }; B?: { displayName?: string } };
  error?: string;
};

check(
  "vote accepted + reveal",
  voteResponse.ok &&
    votePayload.accepted === true &&
    Boolean(votePayload.models),
  votePayload.models
    ? `A=${votePayload.models.A?.displayName}, B=${votePayload.models.B?.displayName}`
    : (votePayload.error ?? `status ${voteResponse.status}`),
);
check(
  "vote is continuable",
  votePayload.continuable === true && Boolean(votePayload.conversationId),
  votePayload.conversationId ?? "no conversationId",
);

if (!votePayload.continuable || !votePayload.conversationId) {
  console.error("\nFAIL: cannot continue without conversationId");
  summarize();
}

console.log("3. Follow-up turn (continuation)…");

matchupCache.clear(THREAD);
starts.length = 0;
eventTypes.length = 0;

const followUp = new ArenaHttpAgent(
  {
    arenaEnabled: true,
    conversationId: votePayload.conversationId,
    sessionId: "copilotkit-probe",
  },
  {
    url: `${arenaUrl}/api/arena/chat?protocol=ag-ui`,
    threadId: THREAD,
  },
);

followUp.messages = [
  { id: "u1", role: "user", content: "probe the arena via CopilotKit agent" },
  ...result.newMessages,
  { id: "u2", role: "user", content: "continue from the winner" },
];

await followUp.runAgent({
  threadId: THREAD,
  runId: "probe-run-2",
});

const continued = matchupCache.get(THREAD);

check(
  "continuation turnIndex is 1",
  continued?.turnIndex === 1,
  continued
    ? `turnIndex=${continued.turnIndex} conversationId=${continued.conversationId}`
    : "no matchup on follow-up",
);
check(
  "continuation keeps same conversation",
  continued?.conversationId === votePayload.conversationId,
  continued?.conversationId ?? "missing",
);

if (appUrl) {
  console.log(`4. App vote proxy was used (${voteUrl})`);
}

summarize();
