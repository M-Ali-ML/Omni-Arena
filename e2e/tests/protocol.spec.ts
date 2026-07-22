import { expect, test } from "@playwright/test";

const ARENA = `http://127.0.0.1:${process.env.E2E_ARENA_PORT ?? "3101"}`;

/** Collect every `data:` JSON payload from a fully-buffered SSE/stream body. */
function dataPayloads(body: string): Array<Record<string, unknown>> {
  return body
    .split(/\n\n/)
    .flatMap((block) =>
      block
        .split(/\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim()),
    )
    .filter((data) => data.length > 0 && data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

async function startMatchup(
  protocol: string,
  prompt: string,
): Promise<{ status: number; body: string; contentType: string }> {
  const response = await fetch(
    `${ARENA}/api/arena/chat?protocol=${protocol}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, sessionId: `e2e-${protocol}` }),
    },
  );
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get("content-type") ?? "",
  };
}

test.describe("arena wire protocols (HTTP)", () => {
  test("vercel-ai: slot A text + slot B data parts, votable, leaderboard updates", async () => {
    const { status, body, contentType } = await startMatchup(
      "vercel-ai",
      "hello arena",
    );
    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);

    const parts = dataPayloads(body);
    expect(parts[0]).toEqual({ type: "start" });

    const meta = parts.find((p) => p.type === "data-arena-meta");
    expect(meta).toBeTruthy();
    const metaData = meta?.data as {
      matchupId: string;
      matchupToken: string;
      mainSlot: string;
      dataSlot: string;
    };
    expect(metaData.mainSlot).toBe("A");
    expect(metaData.dataSlot).toBe("B");
    expect(typeof metaData.matchupId).toBe("string");
    expect(typeof metaData.matchupToken).toBe("string");

    const slotA = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta as string)
      .join("");
    const slotB = parts
      .filter((p) => p.type === "data-arena-b-delta")
      .map((p) => (p.data as { text: string }).text)
      .join("");
    expect(slotA).toContain("Mock reply from Mock Model");
    expect(slotB).toContain("Mock reply from Mock Model");
    expect(parts.some((p) => p.type === "finish")).toBe(true);

    const vote = await fetch(`${ARENA}/api/arena/vote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchupId: metaData.matchupId,
        matchupToken: metaData.matchupToken,
        vote: "left",
      }),
    });
    expect(vote.status).toBe(200);
    const revealed = (await vote.json()) as {
      accepted: boolean;
      models: { A: { displayName: string }; B: { displayName: string } };
    };
    expect(revealed.accepted).toBe(true);
    expect(revealed.models.A.displayName).toBe("Mock Model Alpha");
    expect(revealed.models.B.displayName).toBe("Mock Model Beta");

    const board = await fetch(`${ARENA}/api/arena/leaderboard`);
    expect(board.status).toBe(200);
    const leaderboard = (await board.json()) as {
      models: Array<{ displayName: string; wins: number }>;
    };
    const winner = leaderboard.models.find(
      (m) => m.displayName === "Mock Model Alpha",
    );
    expect(winner?.wins).toBeGreaterThanOrEqual(1);
  });

  test("ag-ui: both slots stream as tagged messages in one run", async () => {
    const { status, body } = await startMatchup("ag-ui", "hello agui");
    expect(status).toBe(200);

    const events = dataPayloads(body);
    expect(events[0]).toEqual(
      expect.objectContaining({ type: "RUN_STARTED" }),
    );
    const starts = events.filter((e) => e.type === "TEXT_MESSAGE_START");
    expect(starts.map((e) => e.slot).sort()).toEqual(["A", "B"]);

    for (const slot of ["A", "B"] as const) {
      const text = events
        .filter((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.slot === slot)
        .map((e) => e.delta as string)
        .join("");
      expect(text).toContain("Mock reply from Mock Model");
    }
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ type: "RUN_FINISHED" }),
    );
  });
});
