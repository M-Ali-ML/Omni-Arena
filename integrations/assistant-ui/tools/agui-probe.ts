// Drives OmniArena's AG-UI adapter with the *real* @ag-ui/client HttpAgent —
// the same client assistant-ui's `useAgUiRuntime` runs on — outside of React.
// It answers the questions the UI cannot: does the AG-UI client accept two
// concurrent slot messages in one run, does the run reach RUN_FINISHED, does
// the `slot` field survive schema validation, and does the `x-arena-matchup`
// header (the vote-token path the stock runtime can use) reach the client?
//
//   ARENA_URL=http://127.0.0.1:3011 npx tsx tools/agui-probe.ts
import { HttpAgent, type RunAgentInput } from "@ag-ui/client";

const arenaUrl = process.env.ARENA_URL ?? "http://127.0.0.1:3011";
const MATCHUP_HEADER = "x-arena-matchup";

class ArenaAgent extends HttpAgent {
  protected override requestInit(input: RunAgentInput): RequestInit {
    const init = super.requestInit({
      ...input,
      forwardedProps: {
        ...(input.forwardedProps as Record<string, unknown> | undefined),
        sessionId: "agui-probe",
        arena: true,
      },
    });
    const headers = new Headers(init.headers);
    // Opt into a matchup: harmless under ARENA_TRIGGER=always, required under
    // `manual` (what harness/arena.ts runs).
    headers.set("x-arena", "on");
    return { ...init, headers };
  }
}

let headerMatchup: Record<string, unknown> | undefined;

const agent = new ArenaAgent({
  url: `${arenaUrl}/api/arena/chat?protocol=ag-ui`,
  fetch: async (input, init) => {
    const response = await fetch(input, init);
    const raw = response.headers.get(MATCHUP_HEADER);
    if (raw) headerMatchup = JSON.parse(raw) as Record<string, unknown>;
    return response;
  },
});

const seen: string[] = [];
let custom: Record<string, unknown> | undefined;
const slotsSeen = new Set<string>();
const starts: string[] = [];

agent.subscribe({
  onEvent: ({ event }) => {
    const typed = event as Record<string, unknown>;
    seen.push(String(typed.type));
    if (typeof typed.slot === "string") slotsSeen.add(typed.slot);
    if (typed.type === "TEXT_MESSAGE_START") starts.push(String(typed.messageId));
  },
  onCustomEvent: ({ event }) => {
    const typed = event as { name?: string; value?: Record<string, unknown> };
    if (typed.name === "arena_matchup") custom = typed.value;
  },
});

agent.messages = [{ id: "u1", role: "user", content: "probe the arena" }];

const result = await agent.runAgent({ runId: "probe-run" });

console.log("events:", seen.join(" → "));
console.log("TEXT_MESSAGE_START ids (order):", starts);
console.log("`slot` field survived client-side schema validation:", [...slotsSeen]);
console.log("x-arena-matchup header:", headerMatchup);
console.log("arena_matchup CUSTOM payload:", custom);
console.log(
  "messages after run:",
  JSON.stringify(
    result.newMessages.map((message) => ({
      id: message.id,
      role: message.role,
      content:
        typeof message.content === "string"
          ? `${message.content.slice(0, 40)}…`
          : message.content,
    })),
    null,
    2,
  ),
);

if (!headerMatchup?.matchupToken) {
  console.error("FAIL: no matchup token reached the client via x-arena-matchup");
  process.exit(1);
}

const voteResponse = await fetch(`${arenaUrl}/api/arena/vote`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    matchupId: headerMatchup.matchupId,
    matchupToken: headerMatchup.matchupToken,
    vote: "left",
  }),
});
console.log("vote:", voteResponse.status, await voteResponse.text());
