import { expect, test } from "@playwright/test";

/**
 * The app's `/api/arena/chat` route is a byte-for-byte proxy of OmniArena's
 * AG-UI stream — no protocol translation — and forwards `x-arena-matchup` so
 * the browser can vote without a `CUSTOM` subscriber.
 */
test("the app proxies OmniArena's AG-UI stream unmodified", async ({ request }) => {
  const response = await request.post("/api/arena/chat", {
    headers: { "content-type": "application/json", "x-arena": "on" },
    data: {
      threadId: "protocol-thread",
      runId: "protocol-run",
      state: {},
      messages: [
        { id: "m1", role: "user", content: "wire check" },
      ],
      tools: [],
      context: [],
      forwardedProps: { sessionId: "protocol-spec", arena: true },
    },
  });

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
  expect(typeof headerMatchup.matchupToken).toBe("string");
  expect(headerMatchup.matchupToken.length).toBeGreaterThan(0);

  const events = (await response.text())
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)));

  const types = events.map((event) => event.type);
  expect(types[0]).toBe("RUN_STARTED");
  expect(types.at(-1)).toBe("RUN_FINISHED");
  // Client threadId/runId are echoed (finding 7).
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
  });

  // Two concurrent text messages, one per slot, tagged by message id.
  const starts = events.filter((event) => event.type === "TEXT_MESSAGE_START");
  expect(starts.map((event) => event.messageId)).toEqual([
    `${matchup.value.matchupId}:A`,
    `${matchup.value.matchupId}:B`,
  ]);
  expect(starts.map((event) => event.slot)).toEqual(["A", "B"]);

  const ends = events.filter((event) => event.type === "TEXT_MESSAGE_END");
  expect(ends).toHaveLength(2);

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

test("a refused run comes back as an in-band AG-UI RUN_ERROR", async ({ request }) => {
  const response = await request.post("/api/arena/chat", {
    headers: { "content-type": "application/json", "x-arena": "on" },
    data: {
      threadId: "protocol-thread",
      runId: "protocol-run",
      state: {},
      messages: [{ id: "m1", role: "user", content: "" }],
      tools: [],
      context: [],
      forwardedProps: { sessionId: "protocol-spec", arena: true },
    },
  });

  expect(response.status()).toBe(200);
  const events = (await response.text())
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)));

  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("RUN_ERROR");
  // OmniArena now emits the terminal error itself, with a machine-readable
  // code, instead of a JSON 400 the proxy had to translate. An empty user
  // message fails the RunAgentInput adapter before the OmniArena `prompt`
  // field is ever materialised.
  expect(events[0].code).toBe("invalid_request");
  expect(events[0].message).toMatch(/invalid request|messages|prompt/i);
});
