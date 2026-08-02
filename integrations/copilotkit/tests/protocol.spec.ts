import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Protocol-level coverage for the CopilotKit integration track.
 *
 * OmniArena's AG-UI adapter is the source of truth: CopilotKit's
 * `ArenaHttpAgent` posts a canonical `RunAgentInput` at
 * `/api/arena/chat?protocol=ag-ui`, and the Next `/api/copilotkit` runtime
 * route is a thin registration of that agent. These tests therefore:
 *
 *   1. Hit OmniArena's AG-UI endpoint directly (no UI rendering ambiguity).
 *   2. Optionally probe the app's `/api/copilotkit` surface when the Next
 *      process is up, asserting the runtime still forwards a usable stream.
 *
 * Vote tokens travel on `CUSTOM` `arena_matchup` **and** the `x-arena-matchup`
 * response header — mainstream AG-UI runtimes (including CopilotKit's) often
 * drop `CUSTOM`, so the header is the path a fetch wrapper / proxy must keep.
 */

const ARENA_PORT = process.env.ARENA_PORT ?? "3031";
const arenaOrigin = `http://127.0.0.1:${ARENA_PORT}`;
const AGUI_CHAT = `${arenaOrigin}/api/arena/chat?protocol=ag-ui`;
const ARENA_VOTE = `${arenaOrigin}/api/arena/vote`;

type AgUiEvent = {
  type: string;
  name?: string;
  value?: Record<string, unknown>;
  messageId?: string;
  slot?: string;
  threadId?: string;
  runId?: string;
  message?: string;
  code?: string;
  delta?: string;
  role?: string;
};

const parseSse = (body: string): AgUiEvent[] =>
  body
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)) as AgUiEvent);

const runAgentBody = (overrides: Record<string, unknown> = {}) => ({
  threadId: "protocol-thread",
  runId: "protocol-run",
  state: {},
  messages: [{ id: "m1", role: "user", content: "wire check" }],
  tools: [],
  context: [],
  forwardedProps: { sessionId: "protocol-spec", arena: true },
  ...overrides,
});

async function postAgUi(
  request: APIRequestContext,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return request.post(AGUI_CHAT, {
    headers: {
      "content-type": "application/json",
      "x-arena": "on",
      ...headers,
    },
    data: body,
  });
}

test("OmniArena AG-UI emits RUN_STARTED → dual TEXT_MESSAGE_* → RUN_FINISHED", async ({
  request,
}) => {
  const response = await postAgUi(request, runAgentBody());

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/event-stream");

  const header = response.headers()["x-arena-matchup"];
  expect(header).toBeTruthy();
  const headerMatchup = JSON.parse(header!);
  expect(headerMatchup).toMatchObject({
    slots: ["A", "B"],
    mode: "matchup",
    votable: true,
    turnIndex: 0,
  });
  expect(typeof headerMatchup.matchupId).toBe("string");
  expect(typeof headerMatchup.matchupToken).toBe("string");
  expect(headerMatchup.matchupToken.length).toBeGreaterThan(0);
  expect(typeof headerMatchup.conversationId).toBe("string");

  const events = parseSse(await response.text());
  const types = events.map((event) => event.type);

  expect(types[0]).toBe("RUN_STARTED");
  expect(types.at(-1)).toBe("RUN_FINISHED");
  // Client threadId/runId are echoed (AG-UI contract).
  expect(events[0].threadId).toBe("protocol-thread");
  expect(events[0].runId).toBe("protocol-run");

  const matchup = events.find(
    (event) => event.type === "CUSTOM" && event.name === "arena_matchup",
  );
  expect(matchup?.value).toMatchObject({
    matchupId: headerMatchup.matchupId,
    matchupToken: headerMatchup.matchupToken,
    slots: ["A", "B"],
    mode: "matchup",
    votable: true,
    turnIndex: 0,
    conversationId: headerMatchup.conversationId,
  });

  // Two concurrent text messages, one per slot. Normative channel is
  // messageId `<matchupId>:<slot>` — conformant parsers strip top-level `slot`.
  const starts = events.filter((event) => event.type === "TEXT_MESSAGE_START");
  expect(starts.map((event) => event.messageId)).toEqual([
    `${matchup!.value!.matchupId}:A`,
    `${matchup!.value!.matchupId}:B`,
  ]);
  // Advisory `slot` is still on the wire from OmniArena; do not rely on it
  // surviving CopilotKit's AG-UI parser.
  expect(starts.map((event) => event.slot)).toEqual(["A", "B"]);

  const ends = events.filter((event) => event.type === "TEXT_MESSAGE_END");
  expect(ends).toHaveLength(2);
  expect(ends.map((event) => event.messageId)).toEqual([
    `${matchup!.value!.matchupId}:A`,
    `${matchup!.value!.matchupId}:B`,
  ]);

  // Both slots stream before either finishes — the interleaving is what makes
  // this a side-by-side arena rather than two sequential answers.
  const firstEnd = types.indexOf("TEXT_MESSAGE_END");
  const contentSlots = new Set(
    events
      .slice(0, firstEnd)
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.slot),
  );
  expect([...contentSlots].sort()).toEqual(["A", "B"]);
});

test("vote round-trip reveals models and marks a decisive vote continuable", async ({
  request,
}) => {
  const chat = await postAgUi(request, runAgentBody({
    messages: [{ id: "m1", role: "user", content: "vote round-trip" }],
    runId: "protocol-vote-run",
  }));
  expect(chat.status()).toBe(200);

  const headerMatchup = JSON.parse(chat.headers()["x-arena-matchup"]!);
  // Drain the stream so the matchup is fully persisted before voting.
  await chat.text();

  const vote = await request.post(ARENA_VOTE, {
    headers: { "content-type": "application/json" },
    data: {
      matchupId: headerMatchup.matchupId,
      matchupToken: headerMatchup.matchupToken,
      vote: "left",
    },
  });
  expect(vote.status()).toBe(200);
  const body = await vote.json();
  expect(body).toMatchObject({
    accepted: true,
    continuable: true,
    conversationId: headerMatchup.conversationId,
    models: {
      A: { displayName: "Mock Model Alpha" },
      B: { displayName: "Mock Model Beta" },
    },
  });

  // Continuation: same conversationId via forwardedProps → turnIndex 1.
  const followUp = await postAgUi(request, runAgentBody({
    threadId: "protocol-thread-continued",
    runId: "protocol-run-1",
    messages: [
      { id: "m1", role: "user", content: "vote round-trip" },
      { id: "a1", role: "assistant", content: "prior" },
      { id: "m2", role: "user", content: "continue please" },
    ],
    forwardedProps: {
      sessionId: "protocol-spec",
      arena: true,
      conversationId: body.conversationId,
    },
  }));
  expect(followUp.status()).toBe(200);
  const followHeader = JSON.parse(followUp.headers()["x-arena-matchup"]!);
  expect(followHeader.conversationId).toBe(body.conversationId);
  expect(followHeader.turnIndex).toBe(1);
  await followUp.text();
});

test("a single-model round carries slots [A], votable false, and no token", async ({
  request,
}) => {
  const response = await request.post(AGUI_CHAT, {
    headers: {
      "content-type": "application/json",
      // ARENA_TRIGGER=manual: omit opt-in → single round.
      "x-arena": "off",
    },
    data: runAgentBody({
      runId: "protocol-single-run",
      messages: [{ id: "m1", role: "user", content: "single round" }],
      forwardedProps: { sessionId: "protocol-spec", arena: false },
    }),
  });

  expect(response.status()).toBe(200);
  const header = response.headers()["x-arena-matchup"];
  expect(header).toBeTruthy();
  const headerMatchup = JSON.parse(header!);
  expect(headerMatchup).toMatchObject({
    slots: ["A"],
    mode: "single",
    votable: false,
  });
  // Identifiers that cannot be used are omitted, not null/empty.
  expect(headerMatchup.matchupToken).toBeUndefined();
  expect(headerMatchup.conversationId).toBeUndefined();
  expect(headerMatchup.turnIndex).toBeUndefined();

  const events = parseSse(await response.text());
  expect(events[0].type).toBe("RUN_STARTED");
  expect(events.at(-1)?.type).toBe("RUN_FINISHED");

  const matchup = events.find(
    (event) => event.type === "CUSTOM" && event.name === "arena_matchup",
  );
  expect(matchup?.value).toMatchObject({
    slots: ["A"],
    mode: "single",
    votable: false,
  });
  expect(matchup?.value?.matchupToken).toBeUndefined();

  const starts = events.filter((event) => event.type === "TEXT_MESSAGE_START");
  expect(starts).toHaveLength(1);
  // Single rounds still mint a synthetic matchupId for messageId routing.
  expect(starts[0].messageId).toMatch(/:A$/);
  expect(
    events.filter((event) => event.type === "TEXT_MESSAGE_END"),
  ).toHaveLength(1);
});

test("a refused AG-UI run comes back as an in-band RUN_ERROR", async ({
  request,
}) => {
  const response = await postAgUi(request, runAgentBody({
    runId: "protocol-error-run",
    messages: [{ id: "m1", role: "user", content: "" }],
  }));

  expect(response.status()).toBe(200);
  const events = parseSse(await response.text());
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("RUN_ERROR");
  expect(events[0].code).toBe("invalid_request");
  expect(events[0].message).toMatch(/invalid request|messages|prompt/i);
});

test("the CopilotKit runtime route accepts a RunAgentInput-shaped POST", async ({
  request,
  baseURL,
}) => {
  // Soft probe: CopilotRuntime's exact request/response framing may differ
  // from a raw AG-UI proxy. Failures here are merge-time reconciliation signals,
  // not harness bugs — the direct OmniArena tests above are authoritative.
  const response = await request.post(`${baseURL}/api/copilotkit`, {
    headers: { "content-type": "application/json" },
    data: runAgentBody({
      threadId: "copilotkit-protocol-thread",
      runId: "copilotkit-protocol-run",
      forwardedProps: { sessionId: "protocol-spec", arena: true },
    }),
    failOnStatusCode: false,
  });

  // CopilotKit may answer 200 (SSE), 400 (wrong envelope), or 404 (route not
  // registered yet on this parallel track). Record the shape; do not soft-pass
  // a 5xx — that would hide a real runtime crash once the app lands.
  expect(
    [200, 400, 404, 405].includes(response.status()),
    `unexpected /api/copilotkit status ${response.status()}`,
  ).toBe(true);

  if (response.status() === 200) {
    const contentType = response.headers()["content-type"] ?? "";
    // Runtime may stream SSE or return a JSON envelope; either is fine as long
    // as the process accepted the POST.
    expect(
      contentType.includes("text/event-stream") ||
        contentType.includes("application/json") ||
        contentType.includes("text/plain"),
    ).toBe(true);
  }
});
