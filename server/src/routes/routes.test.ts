import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { JoinBroker } from "../arena/join.js";
import type { ArenaModeConfig } from "../arena/mode.js";
import { ArenaCore } from "../core/arena.js";
import type {
  ArenaVote,
  ChatMessage,
  LeaderboardEntry,
  MatchupAssignment,
  MatchupRecord,
  Model,
  PreferenceRecord,
  PreferenceRepositoryPort,
  RatingContext,
  ResponseRecord,
} from "../core/ports.js";
import { ProviderRegistry } from "../providers/registry.js";
import { DuplicateVoteError } from "../repo/postgres.js";
import { MatchupTokenService } from "../token.js";

const slotA: Model = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "Secret Alpha",
  provider: "test",
  providerModelId: "alpha",
  enabled: true,
};
const slotB: Model = {
  id: "00000000-0000-4000-8000-000000000002",
  displayName: "Secret Beta",
  provider: "test",
  providerModelId: "beta",
  enabled: true,
};
const assignment: MatchupAssignment = {
  modelA: slotA,
  modelB: slotB,
  slotA,
  slotB,
};

class MemoryRepository implements PreferenceRepositoryPort {
  readonly matchups = new Map<string, MatchupRecord>();
  readonly responses: ResponseRecord[] = [];
  readonly preferences = new Map<string, PreferenceRecord>();

  async listEnabledModels(): Promise<Model[]> {
    return [slotA, slotB];
  }

  async createMatchup(matchup: MatchupRecord): Promise<void> {
    this.matchups.set(matchup.id, matchup);
  }

  async saveResponse(response: ResponseRecord): Promise<void> {
    this.responses.push(response);
  }

  readonly steers: Array<{ matchupId: string; instruction: string }> = [];

  async recordSteer(matchupId: string, instruction: string): Promise<void> {
    this.steers.push({ matchupId, instruction });
  }

  async recordPreference(preference: PreferenceRecord): Promise<void> {
    if (this.preferences.has(preference.matchupId)) {
      throw new DuplicateVoteError();
    }
    this.preferences.set(preference.matchupId, preference);
  }

  async getConversationContext(
    conversationId: string,
    anonymousSessionId: string | null,
  ) {
    const turns = [...this.matchups.values()]
      .filter((matchup) => matchup.conversation.id === conversationId)
      .sort(
        (left, right) =>
          left.conversation.turnIndex - right.conversation.turnIndex,
      );
    if (turns.length === 0) {
      return { status: "not_found" as const };
    }
    if (
      turns[0]?.conversation.anonymousSessionId !== anonymousSessionId
    ) {
      return { status: "forbidden" as const };
    }

    const messages: ChatMessage[] = [];
    let parentResponseId: string | null = null;
    for (const turn of turns) {
      const preference = this.preferences.get(turn.id);
      const winner = this.responses.find(
        (response) =>
          response.matchupId === turn.id &&
          response.modelId === preference?.winnerModelId,
      );
      if (!winner) {
        return { status: "not_ready" as const };
      }
      messages.push(
        { role: "user", content: turn.prompt },
        { role: "assistant", content: winner.content },
      );
      parentResponseId = `${turn.id}:${winner.slot}`;
    }
    const latest = turns.at(-1);
    if (!latest || !parentResponseId) {
      return { status: "not_ready" as const };
    }
    return {
      status: "ready" as const,
      conversationId,
      nextTurnIndex: latest.conversation.turnIndex + 1,
      parentResponseId,
      messages,
    };
  }

  async getMatchup(matchupId: string) {
    const matchup = this.matchups.get(matchupId);
    return matchup
      ? {
          id: matchup.id,
          matchupTokenHash: matchup.matchupTokenHash,
          conversationId: matchup.conversation.id,
          turnIndex: matchup.conversation.turnIndex,
          vote: this.preferences.get(matchup.id)?.vote ?? null,
          mode: matchup.mode,
          slotA: matchup.slotAModelId === slotA.id ? slotA : slotB,
          slotB: matchup.slotBModelId === slotB.id ? slotB : slotA,
        }
      : null;
  }

  async getConversationTurns(
    conversationId: string,
    anonymousSessionId: string | null,
  ) {
    const matchups = [...this.matchups.values()]
      .filter((matchup) => matchup.conversation.id === conversationId)
      .sort(
        (left, right) =>
          left.conversation.turnIndex - right.conversation.turnIndex,
      );
    if (matchups.length === 0) {
      return { status: "not_found" as const };
    }
    if (matchups[0]?.conversation.anonymousSessionId !== anonymousSessionId) {
      return { status: "forbidden" as const };
    }
    return {
      status: "ready" as const,
      conversationId,
      turns: matchups.map((matchup) => ({
        turnIndex: matchup.conversation.turnIndex,
        matchupId: matchup.id,
        prompt: matchup.prompt,
        answers: this.responses
          .filter((response) => response.matchupId === matchup.id)
          .map((response) => ({
            slot: response.slot,
            content: response.content,
            error: response.error,
          })),
        vote: this.preferences.get(matchup.id)?.vote ?? null,
        slotA,
        slotB,
      })),
    };
  }

  async getLeaderboard(): Promise<LeaderboardEntry[]> {
    const preference = [...this.preferences.values()][0];
    return [slotA, slotB].map((model) => {
      const isDecisive =
        preference?.vote === "left" || preference?.vote === "right";
      const wins = preference?.winnerModelId === model.id ? 1 : 0;
      const losses = isDecisive && wins === 0 ? 1 : 0;
      const ties =
        preference?.vote === "both_good" || preference?.vote === "both_bad"
          ? 1
          : 0;
      return {
        id: model.id,
        displayName: model.displayName,
        wins,
        losses,
        ties,
        skips: preference?.vote === "skip" ? 1 : 0,
        totalVotes: preference ? 1 : 0,
        winRate: wins + losses + ties === 0 ? 0 : wins / (wins + losses + ties),
        rating: null,
        ratingStdError: null,
        confidenceInterval: null,
        componentId: null,
        styleControlledRating: null,
        styleControlledStdError: null,
        styleControlledConfidenceInterval: null,
      };
    });
  }

  // No rating worker runs against an in-memory repository, so the context is
  // the shape a fresh install serves.
  async getRatingContext(): Promise<RatingContext> {
    return {
      components: { count: null, groups: [] },
      styleControl: { effects: [], votesObserved: 0, computedAt: null },
    };
  }
}

function parseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim(),
    )
    .filter((data): data is string => Boolean(data) && data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

async function setup(
  modeConfig: ArenaModeConfig = {
    trigger: "always",
    exposure: "blind",
    defaultModel: null,
    sampleRate: 0,
  },
  overrides: {
    webDistDir?: string;
    failSaveResponse?: boolean;
    joinBroker?: JoinBroker;
    rng?: () => number;
  } = {},
) {
  const repository = new MemoryRepository();
  if (overrides.failSaveResponse) {
    repository.saveResponse = async () => {
      throw new Error("database is on fire");
    };
  }
  const receivedMessages: ChatMessage[][] = [];
  const provider = {
    async *stream(model: Model, messages: ChatMessage[]) {
      receivedMessages.push(messages);
      yield {
        type: "metadata" as const,
        modelVersion: `${model.providerModelId}-2026-07`,
        outputTokenCount: 3,
      };
      yield {
        type: "token" as const,
        token: `Answer from ${model.providerModelId}`,
      };
    },
  };
  const app = await createApp({
    core: new ArenaCore(new ProviderRegistry().register("test", provider)),
    matchmaker: { async pick() { return assignment; } },
    repository,
    tokens: new MatchupTokenService("test-secret-long-enough"),
    harnessVersion: "test-harness-v1",
    modeConfig,
    joinBroker: overrides.joinBroker,
    webDistDir: overrides.webDistDir,
    rng: overrides.rng,
  });
  return { app, repository, receivedMessages };
}

/** A web bundle just real enough for the SPA fallback to be registered. */
async function webBundle(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "arena-web-"));
  await writeFile(path.join(directory, "index.html"), "<!doctype html>spa");
  return directory;
}

describe("arena routes", () => {
  it("masks identities until a valid vote and rejects token tampering", async () => {
    const { app, repository } = await setup();
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: { prompt: "Hello", sessionId: "anon_test" },
      });
      expect(chat.statusCode).toBe(200);

      const events = parseEvents(chat.body);
      const started = events[0];
      expect(started?.type).toBe("matchup_started");
      expect(JSON.stringify(started)).not.toContain(slotA.displayName);
      expect(JSON.stringify(started)).not.toContain(slotB.displayName);

      const matchupId = started?.matchupId as string;
      const matchupToken = started?.matchupToken as string;
      const invalid = await app.inject({
        method: "POST",
        url: "/api/arena/vote",
        payload: {
          matchupId,
          matchupToken: `${matchupToken.slice(0, -1)}x`,
          vote: "left" satisfies ArenaVote,
        },
      });
      expect(invalid.statusCode).toBe(401);

      const vote = await app.inject({
        method: "POST",
        url: "/api/arena/vote",
        payload: { matchupId, matchupToken, vote: "left" },
      });
      expect(vote.statusCode).toBe(200);
      expect(vote.json().models).toEqual({
        A: { id: slotA.id, displayName: slotA.displayName },
        B: { id: slotB.id, displayName: slotB.displayName },
      });
      expect(repository.responses).toHaveLength(2);
      expect(repository.responses[0]).toMatchObject({
        outputTokenCount: 3,
        tokenCountSource: "provider",
        modelVersion: "alpha-2026-07",
      });
      expect(
        repository.matchups.get(matchupId)?.harnessVersion,
      ).toBe("test-harness-v1");

      const leaderboard = await app.inject({
        method: "GET",
        url: "/api/arena/leaderboard",
      });
      expect(leaderboard.statusCode).toBe(200);
      expect(leaderboard.json().models[0]).toMatchObject({
        id: slotA.id,
        wins: 1,
        winRate: 1,
      });
      // Rating context rides alongside `models` so no client can fetch ratings
      // without the connectivity caveat that qualifies them.
      expect(leaderboard.json()).toMatchObject({
        components: { count: null, groups: [] },
        styleControl: { effects: [], votesObserved: 0, computedAt: null },
      });

      const duplicate = await app.inject({
        method: "POST",
        url: "/api/arena/vote",
        payload: { matchupId, matchupToken, vote: "right" },
      });
      expect(duplicate.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("continues only from the latest winning response", async () => {
    const { app, receivedMessages } = await setup();
    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: { prompt: "First turn", sessionId: "anon_linear" },
      });
      const started = parseEvents(first.body)[0];
      const conversationId = started?.conversationId as string;
      expect(started?.turnIndex).toBe(0);

      const premature = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: {
          prompt: "Too soon",
          sessionId: "anon_linear",
          conversationId,
        },
      });
      expect(premature.statusCode).toBe(409);

      await app.inject({
        method: "POST",
        url: "/api/arena/vote",
        payload: {
          matchupId: started?.matchupId,
          matchupToken: started?.matchupToken,
          vote: "left",
        },
      });
      const followUp = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: {
          prompt: "Follow up",
          sessionId: "anon_linear",
          conversationId,
        },
      });
      expect(followUp.statusCode).toBe(200);
      expect(parseEvents(followUp.body)[0]).toMatchObject({
        conversationId,
        turnIndex: 1,
      });
      expect(receivedMessages.at(-1)).toEqual([
        { role: "user", content: "First turn" },
        { role: "assistant", content: "Answer from alpha" },
        { role: "user", content: "Follow up" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("manual trigger without opt-in streams a single, non-votable slot", async () => {
    const { app, repository } = await setup({
      trigger: "manual",
      exposure: "blind",
      defaultModel: slotA.id,
      sampleRate: 0,
    });
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: { prompt: "Hello", sessionId: "anon_single" },
      });
      expect(chat.statusCode).toBe(200);

      const events = parseEvents(chat.body);
      const started = events[0];
      expect(started).toMatchObject({
        type: "matchup_started",
        mode: "single",
        votable: false,
        slots: ["A"],
      });
      // A single round persists no matchup and no conversation, so it emits
      // neither a vote token nor ids that would answer 404 if replayed.
      expect(started).not.toHaveProperty("matchupToken");
      expect(started).not.toHaveProperty("conversationId");
      expect(started).not.toHaveProperty("turnIndex");

      const slotDone = events.filter((event) => event.type === "slot_done");
      expect(slotDone).toHaveLength(1);
      expect(slotDone[0]).toMatchObject({ slot: "A" });
      expect(events.some((event) => event.slot === "B")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "matchup_done" });

      // Single is fire-and-forget: no matchup row, no persisted responses.
      expect(repository.matchups.size).toBe(0);
      expect(repository.responses).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("single rounds do not hand out a conversationId that 404s on replay", async () => {
    // Regression: the original single path minted a fresh conversationId (and
    // an empty matchupToken) without persisting either, so a client that saved
    // the id and sent it back got conversation_not_found. Single must advertise
    // nothing continuable — only the control-plane matchupId stays.
    const { app } = await setup({
      trigger: "manual",
      exposure: "blind",
      defaultModel: slotA.id,
      sampleRate: 0,
    });
    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: { prompt: "Hello", sessionId: "anon_single_replay" },
      });
      expect(first.statusCode).toBe(200);

      const started = parseEvents(first.body)[0];
      expect(started).toMatchObject({
        type: "matchup_started",
        mode: "single",
        votable: false,
        slots: ["A"],
      });
      expect(started).not.toHaveProperty("conversationId");
      expect(started).not.toHaveProperty("turnIndex");
      expect(started).not.toHaveProperty("matchupToken");

      const header = JSON.parse(
        first.headers["x-arena-matchup"] as string,
      ) as Record<string, unknown>;
      expect(header).toEqual({
        matchupId: started?.matchupId,
        slots: ["A"],
        mode: "single",
        votable: false,
      });
      expect(header).not.toHaveProperty("conversationId");

      // A client that still mistook the stream's matchupId for a conversation
      // id and replayed it under a matchup plan must get a clean 404 — there
      // is no row behind that uuid.
      const replay = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: {
          prompt: "Follow up",
          sessionId: "anon_single_replay",
          conversationId: started?.matchupId,
          arena: true,
        },
      });
      expect(replay.statusCode).toBe(404);
      expect(replay.json()).toEqual({ error: "Conversation not found" });
    } finally {
      await app.close();
    }
  });

  it("manual trigger with arena:true runs a full matchup", async () => {
    const { app } = await setup({
      trigger: "manual",
      exposure: "blind",
      defaultModel: slotA.id,
      sampleRate: 0,
    });
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: { prompt: "Hello", sessionId: "anon_optin", arena: true },
      });
      expect(chat.statusCode).toBe(200);
      const started = parseEvents(chat.body)[0];
      expect(started).toMatchObject({
        type: "matchup_started",
        mode: "matchup",
        votable: true,
        slots: ["A", "B"],
      });
      expect(started?.matchupToken).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("manual trigger opts in via the x-arena header", async () => {
    const { app } = await setup({
      trigger: "manual",
      exposure: "blind",
      defaultModel: slotA.id,
      sampleRate: 0,
    });
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        headers: { "x-arena": "on" },
        payload: { prompt: "Hello", sessionId: "anon_header" },
      });
      expect(chat.statusCode).toBe(200);
      expect(parseEvents(chat.body)[0]).toMatchObject({
        type: "matchup_started",
        mode: "matchup",
        votable: true,
      });
    } finally {
      await app.close();
    }
  });

  it("sampled trigger miss (rng >= rate) streams a single, non-votable slot", async () => {
    const { app, repository } = await setup(
      {
        trigger: "sampled",
        exposure: "blind",
        defaultModel: slotA.id,
        sampleRate: 0.5,
      },
      { rng: () => 0.9 },
    );
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: { prompt: "Hello", sessionId: "anon_sampled_miss" },
      });
      expect(chat.statusCode).toBe(200);
      expect(parseEvents(chat.body)[0]).toMatchObject({
        type: "matchup_started",
        mode: "single",
        votable: false,
        slots: ["A"],
      });
      expect(repository.matchups.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("sampled trigger hit (rng < rate) runs a full matchup", async () => {
    const { app } = await setup(
      {
        trigger: "sampled",
        exposure: "blind",
        defaultModel: slotA.id,
        sampleRate: 0.5,
      },
      { rng: () => 0.1 },
    );
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: { prompt: "Hello", sessionId: "anon_sampled_hit" },
      });
      expect(chat.statusCode).toBe(200);
      const started = parseEvents(chat.body)[0];
      expect(started).toMatchObject({
        type: "matchup_started",
        mode: "matchup",
        votable: true,
        slots: ["A", "B"],
      });
      expect(started?.matchupToken).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("default env keeps the blind matchup path (regression)", async () => {
    const { app } = await setup();
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: { prompt: "Hello", sessionId: "anon_default" },
      });
      expect(chat.statusCode).toBe(200);
      expect(parseEvents(chat.body)[0]).toMatchObject({
        type: "matchup_started",
        mode: "matchup",
        votable: true,
        slots: ["A", "B"],
      });
    } finally {
      await app.close();
    }
  });

  it("shadow exposure streams only A, persists both responses, and issues no token", async () => {
    const { app, repository } = await setup({
      trigger: "always",
      exposure: "shadow",
      defaultModel: slotA.id,
      sampleRate: 0,
    });
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: { prompt: "Hello", sessionId: "anon_shadow" },
      });
      expect(chat.statusCode).toBe(200);

      const events = parseEvents(chat.body);
      const started = events[0];
      expect(started).toMatchObject({
        type: "matchup_started",
        mode: "shadow",
        votable: false,
        slots: ["A"],
      });
      expect(started).not.toHaveProperty("matchupToken");
      expect(started?.matchupId).toBeTruthy();
      expect(started?.conversationId).toBeTruthy();

      // Only A tokens reach the wire; B still runs and is persisted.
      expect(events.some((event) => event.slot === "B")).toBe(false);
      const slotDone = events.filter((event) => event.type === "slot_done");
      expect(slotDone).toHaveLength(1);
      expect(slotDone[0]).toMatchObject({ slot: "A" });
      expect(events.at(-1)).toMatchObject({ type: "matchup_done" });

      const matchupId = started?.matchupId as string;
      expect(repository.matchups.get(matchupId)).toMatchObject({
        mode: "shadow",
        modelAId: slotA.id,
        modelBId: slotB.id,
        slotAModelId: slotA.id,
        slotBModelId: slotB.id,
      });
      expect(repository.responses).toHaveLength(2);
      expect(repository.responses.map((response) => response.slot).sort()).toEqual([
        "A",
        "B",
      ]);
    } finally {
      await app.close();
    }
  });

  it("vote endpoint rejects votes on shadow matchups", async () => {
    const tokens = new MatchupTokenService("test-secret-long-enough");
    const { app, repository } = await setup({
      trigger: "always",
      exposure: "shadow",
      defaultModel: slotA.id,
      sampleRate: 0,
    });
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: { prompt: "Hello", sessionId: "anon_shadow_vote" },
      });
      const matchupId = parseEvents(chat.body)[0]?.matchupId as string;
      const record = repository.matchups.get(matchupId);
      expect(record?.mode).toBe("shadow");

      // Mint a token that matches the stored hash so the rejection is for mode,
      // not for a missing/invalid token (shadow never puts a token on the wire).
      const issued = tokens.issue({
        matchupId,
        slotAModelId: record!.slotAModelId,
        slotBModelId: record!.slotBModelId,
        sessionId: "anon_shadow_vote",
      });
      record!.matchupTokenHash = issued.hash;

      const vote = await app.inject({
        method: "POST",
        url: "/api/arena/vote",
        payload: {
          matchupId,
          matchupToken: issued.token,
          vote: "left",
        },
      });
      expect(vote.statusCode).toBe(403);
      expect(vote.json().error).toMatch(/shadow/i);
      expect(repository.preferences.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("reports a mid-stream failure in-band instead of ending silently", async () => {
    const { app } = await setup(undefined, { failSaveResponse: true });
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: { prompt: "Hello", sessionId: "anon_midstream" },
      });
      expect(chat.statusCode).toBe(200);
      const events = parseEvents(chat.body);
      // The response is already committed at 200, so the only honest terminator
      // is an in-band error; before this the body just stopped.
      expect(events.at(-1)).toMatchObject({
        type: "run_error",
        code: "stream_failed",
        message: "database is on fire",
      });
      expect(events.some((event) => event.type === "matchup_done")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("answers an AG-UI request's failure with an in-band RUN_ERROR", async () => {
    const { app } = await setup();
    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/arena/chat?protocol=ag-ui",
        payload: { prompt: "First turn", sessionId: "anon_agui" },
      });
      const matchup = parseEvents(first.body).find(
        (event) => event.name === "arena_matchup",
      )?.value as { conversationId: string };

      // Continuing before voting is a 409 for a JSON client; an AG-UI client
      // has no way to render one, and a run it never sees end hangs forever.
      const premature = await app.inject({
        method: "POST",
        url: "/api/arena/chat?protocol=ag-ui",
        payload: {
          prompt: "Too soon",
          sessionId: "anon_agui",
          conversationId: matchup.conversationId,
        },
      });
      expect(premature.statusCode).toBe(200);
      expect(parseEvents(premature.body)).toEqual([
        {
          type: "RUN_ERROR",
          code: "conversation_not_ready",
          message:
            "Vote for a winning response before continuing this conversation",
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it("keeps HTTP status codes for protocols whose clients read them", async () => {
    const { app } = await setup();
    try {
      const unknownConversation = await app.inject({
        method: "POST",
        url: "/api/arena/chat",
        payload: {
          prompt: "Hello",
          sessionId: "anon_status",
          conversationId: "00000000-0000-4000-8000-0000000000ff",
        },
      });
      expect(unknownConversation.statusCode).toBe(404);
      expect(unknownConversation.json()).toEqual({
        error: "Conversation not found",
      });
    } finally {
      await app.close();
    }
  });

  it("serves an OpenAI-shaped model list from the enabled roster", async () => {
    const { app } = await setup();
    try {
      for (const url of ["/models", "/v1/models"]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.json()).toMatchObject({
          object: "list",
          data: [
            { id: slotA.id, object: "model", owned_by: "test" },
            { id: slotB.id, object: "model", owned_by: "test" },
          ],
        });
      }
    } finally {
      await app.close();
    }
  });

  it("404s API-ish paths as JSON even with the SPA fallback installed", async () => {
    const { app } = await setup(undefined, { webDistDir: await webBundle() });
    try {
      // An OpenAI client that got HTML at 200 here reported only "unexpected
      // mimetype", which hid the fact that the route was missing.
      const apiish = await app.inject({ method: "GET", url: "/v1/embeddings" });
      expect(apiish.statusCode).toBe(404);
      expect(apiish.json()).toEqual({ error: "Not Found" });

      const spa = await app.inject({ method: "GET", url: "/leaderboard" });
      expect(spa.statusCode).toBe(200);
      expect(spa.body).toContain("spa");
    } finally {
      await app.close();
    }
  });

  it("streams a matchup for an unmodified AG-UI RunAgentInput", async () => {
    const { app, receivedMessages } = await setup();
    try {
      // Byte-for-byte what `new HttpAgent({ url })` posts — the body that used
      // to come back `400 {"prompt":["expected string, received undefined"]}`.
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat?protocol=ag-ui",
        payload: {
          threadId: "t1",
          runId: "r1",
          state: {},
          messages: [{ id: "m1", role: "user", content: "Hello" }],
          tools: [],
          context: [],
          forwardedProps: {},
        },
      });
      expect(chat.statusCode).toBe(200);

      const events = parseEvents(chat.body);
      expect(events[0]).toMatchObject({ type: "RUN_STARTED" });
      const matchup = events.find(
        (event) => event.name === "arena_matchup",
      )?.value as { matchupToken: string; slots: string[] };
      expect(matchup.slots).toEqual(["A", "B"]);
      expect(matchup.matchupToken).toBeTruthy();
      expect(
        events.filter((event) => event.type === "TEXT_MESSAGE_START"),
      ).toHaveLength(2);
      expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
      // Both models answered the message the client actually sent.
      expect(receivedMessages).toEqual([
        [{ role: "user", content: "Hello" }],
        [{ role: "user", content: "Hello" }],
      ]);
      expect(chat.body).not.toContain(slotA.displayName);
    } finally {
      await app.close();
    }
  });

  it("continues an AG-UI conversation through forwardedProps", async () => {
    const { app, receivedMessages } = await setup();
    try {
      const runInput = (
        content: string,
        forwardedProps: Record<string, unknown>,
      ) => ({
        threadId: "t1",
        runId: "r1",
        state: {},
        messages: [{ id: "m1", role: "user", content }],
        tools: [],
        context: [],
        forwardedProps,
      });

      const first = await app.inject({
        method: "POST",
        url: "/api/arena/chat?protocol=ag-ui",
        payload: runInput("First turn", { sessionId: "anon_run_input" }),
      });
      const matchup = parseEvents(first.body).find(
        (event) => event.name === "arena_matchup",
      )?.value as {
        matchupId: string;
        matchupToken: string;
        conversationId: string;
      };

      await app.inject({
        method: "POST",
        url: "/api/arena/vote",
        payload: {
          matchupId: matchup.matchupId,
          matchupToken: matchup.matchupToken,
          vote: "left",
        },
      });

      const followUp = await app.inject({
        method: "POST",
        url: "/api/arena/chat?protocol=ag-ui",
        payload: runInput("Follow up", {
          sessionId: "anon_run_input",
          conversationId: matchup.conversationId,
        }),
      });
      expect(followUp.statusCode).toBe(200);
      expect(
        parseEvents(followUp.body).find(
          (event) => event.name === "arena_matchup",
        )?.value,
      ).toMatchObject({
        conversationId: matchup.conversationId,
        turnIndex: 1,
      });
      // History still comes from the persisted winning response, not from the
      // transcript the client posted.
      expect(receivedMessages.at(-1)).toEqual([
        { role: "user", content: "First turn" },
        { role: "assistant", content: "Answer from alpha" },
        { role: "user", content: "Follow up" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("streams a matchup for an unmodified /chat/completions body", async () => {
    const { app, repository, receivedMessages } = await setup();
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat?protocol=openai",
        payload: {
          model: "omni-arena",
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Hello" },
          ],
          stream: true,
          temperature: 0.7,
          user: "anon_openai",
        },
      });
      expect(chat.statusCode).toBe(200);
      expect(chat.headers["content-type"]).toContain("text/event-stream");

      const chunks = parseEvents(chat.body);
      const first = chunks[0] as {
        object: string;
        choices: Array<{ index: number }>;
        omni_arena: { matchupId: string; matchupToken: string };
      };
      expect(first.object).toBe("chat.completion.chunk");
      expect(first.choices.map((choice) => choice.index)).toEqual([0, 1]);
      expect(first.omni_arena.matchupToken).toBeTruthy();
      expect(chat.body.trimEnd().endsWith("data: [DONE]")).toBe(true);

      expect(receivedMessages.at(-1)).toEqual([
        { role: "user", content: "Hello" },
      ]);
      // OpenAI's `user` becomes the anonymous session, so the round is bound to
      // the same caller a continuation would come from.
      expect(
        repository.matchups.get(first.omni_arena.matchupId)?.conversation
          .anonymousSessionId,
      ).toBe("anon_openai");
    } finally {
      await app.close();
    }
  });

  it("serves the arena at the OpenAI chat-completions paths", async () => {
    const { app } = await setup();
    try {
      // An OpenAI client is configured with a base URL and appends the path
      // itself, so it can never send `?protocol=openai`.
      for (const url of ["/chat/completions", "/v1/chat/completions"]) {
        const chat = await app.inject({
          method: "POST",
          url,
          headers: { accept: "text/event-stream" },
          payload: {
            model: "omni-arena",
            messages: [{ role: "user", content: "Hello" }],
            stream: true,
          },
        });
        expect(chat.statusCode).toBe(200);
        expect(chat.body).toContain('"object":"chat.completion.chunk"');
        expect(chat.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  it("rejects a non-streaming completion request with a clear reason", async () => {
    const { app } = await setup();
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat?protocol=openai",
        payload: {
          model: "omni-arena",
          messages: [{ role: "user", content: "Hello" }],
          stream: false,
        },
      });
      expect(chat.statusCode).toBe(400);
      expect(chat.json().details).toMatchObject({
        stream: [expect.stringContaining("streams")],
      });
    } finally {
      await app.close();
    }
  });

  it("streams a matchup for an unmodified useChat body", async () => {
    const { app, receivedMessages } = await setup();
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat?protocol=vercel",
        payload: {
          id: "chat-1",
          trigger: "submit-message",
          messages: [
            {
              id: "m1",
              role: "user",
              parts: [{ type: "text", text: "Hello" }],
            },
          ],
          sessionId: "anon_use_chat",
        },
      });
      expect(chat.statusCode).toBe(200);
      expect(chat.headers["x-vercel-ai-ui-message-stream"]).toBe("v1");
      expect(
        parseEvents(chat.body).find(
          (part) => part.type === "data-arena-meta",
        )?.data,
      ).toMatchObject({ mainSlot: "A", dataSlot: "B", votable: true });
      expect(receivedMessages.at(-1)).toEqual([
        { role: "user", content: "Hello" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("selects a non-default protocol via the query param", async () => {
    const { app } = await setup();
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat?protocol=openai",
        payload: { prompt: "Hello", sessionId: "anon_proto" },
      });
      expect(chat.statusCode).toBe(200);
      expect(chat.headers["content-type"]).toContain("text/event-stream");
      expect(chat.body).toContain('"object":"chat.completion.chunk"');
      expect(chat.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
      // The default path stays plain SSE (no chat-completion framing).
      expect(chat.body).not.toContain("matchup_started");
    } finally {
      await app.close();
    }
  });
});

/**
 * Reading a round back out of band: the header, the matchup GET, and the
 * conversation GET are what a host uses when its runtime dropped the stream's
 * metadata or when the page was reloaded and the client state is gone.
 */
describe("out-of-band reads", () => {
  const start = (
    app: Awaited<ReturnType<typeof setup>>["app"],
    payload: Record<string, unknown>,
    url = "/api/arena/chat",
  ) => app.inject({ method: "POST", url, payload });

  it("repeats the matchup metadata in a response header on every protocol", async () => {
    const { app } = await setup();
    try {
      for (const url of [
        "/api/arena/chat",
        "/api/arena/chat?protocol=ag-ui",
        "/api/arena/chat?protocol=vercel",
      ]) {
        const chat = await start(app, {
          prompt: "Hello",
          sessionId: "anon_header_read",
        }, url);
        const header = JSON.parse(
          chat.headers["x-arena-matchup"] as string,
        ) as Record<string, unknown>;

        // Same payload the stream carries, minus the event type — this is the
        // only copy a runtime that discards CUSTOM events can reach.
        expect(header).toMatchObject({
          mode: "matchup",
          votable: true,
          slots: ["A", "B"],
          turnIndex: 0,
        });
        expect(header.matchupToken).toBeTruthy();
        expect(header.conversationId).toBeTruthy();
        expect(JSON.stringify(header)).not.toContain(slotA.displayName);
      }
    } finally {
      await app.close();
    }
  });

  it("omits the token from the header of a non-votable round", async () => {
    const { app } = await setup({
      trigger: "manual",
      exposure: "blind",
      defaultModel: slotA.id,
      sampleRate: 0,
    });
    try {
      const chat = await start(app, {
        prompt: "Hello",
        sessionId: "anon_header_single",
      });
      expect(JSON.parse(chat.headers["x-arena-matchup"] as string)).toEqual({
        matchupId: expect.any(String),
        slots: ["A"],
        mode: "single",
        votable: false,
      });
    } finally {
      await app.close();
    }
  });

  it("serves a matchup's shape without its token, revealing only after a vote", async () => {
    const { app } = await setup();
    try {
      const chat = await start(app, {
        prompt: "Hello",
        sessionId: "anon_matchup_get",
      });
      const started = parseEvents(chat.body)[0];
      const matchupId = started?.matchupId as string;

      const open = await app.inject({
        method: "GET",
        url: `/api/arena/matchups/${matchupId}`,
      });
      expect(open.statusCode).toBe(200);
      expect(open.json()).toEqual({
        matchupId,
        conversationId: started?.conversationId,
        turnIndex: 0,
        mode: "matchup",
        votable: true,
        continuable: false,
        vote: null,
        models: null,
      });
      // The token is a capability, not metadata: an unauthenticated read that
      // returned it would let anyone with a matchup id vote.
      expect(open.body).not.toContain(started?.matchupToken as string);
      expect(open.body).not.toContain(slotA.displayName);

      await app.inject({
        method: "POST",
        url: "/api/arena/vote",
        payload: {
          matchupId,
          matchupToken: started?.matchupToken,
          vote: "left",
        },
      });

      const voted = await app.inject({
        method: "GET",
        url: `/api/arena/matchups/${matchupId}`,
      });
      expect(voted.json()).toMatchObject({
        votable: false,
        continuable: true,
        vote: "left",
        models: {
          A: { id: slotA.id, displayName: slotA.displayName },
          B: { id: slotB.id, displayName: slotB.displayName },
        },
      });

      const missing = await app.inject({
        method: "GET",
        url: "/api/arena/matchups/00000000-0000-4000-8000-0000000000ff",
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("tells a voter whether the conversation can be continued", async () => {
    const { app } = await setup();
    try {
      for (const [vote, continuable] of [
        ["left", true],
        ["both_good", false],
      ] as const) {
        const chat = await start(app, {
          prompt: "Hello",
          sessionId: `anon_continuable_${vote}`,
        });
        const started = parseEvents(chat.body)[0];
        const response = await app.inject({
          method: "POST",
          url: "/api/arena/vote",
          payload: {
            matchupId: started?.matchupId,
            matchupToken: started?.matchupToken,
            vote,
          },
        });
        expect(response.json()).toMatchObject({
          accepted: true,
          continuable,
          conversationId: started?.conversationId,
        });
      }
    } finally {
      await app.close();
    }
  });

  it("rehydrates a conversation including the turn still awaiting a vote", async () => {
    const { app } = await setup();
    try {
      const first = await start(app, {
        prompt: "First turn",
        sessionId: "anon_rehydrate",
      });
      const started = parseEvents(first.body)[0];
      const conversationId = started?.conversationId as string;
      await app.inject({
        method: "POST",
        url: "/api/arena/vote",
        payload: {
          matchupId: started?.matchupId,
          matchupToken: started?.matchupToken,
          vote: "left",
        },
      });
      await start(app, {
        prompt: "Follow up",
        sessionId: "anon_rehydrate",
        conversationId,
      });

      const thread = await app.inject({
        method: "GET",
        url: `/api/arena/conversations/${conversationId}?sessionId=anon_rehydrate`,
      });
      expect(thread.statusCode).toBe(200);
      const body = thread.json();
      expect(body).toMatchObject({
        conversationId,
        // The unvoted second turn is exactly the state a reload must restore,
        // and it is not continuable until it is decided.
        continuable: false,
        nextTurnIndex: 2,
      });
      expect(body.turns).toHaveLength(2);
      expect(body.turns[0]).toMatchObject({
        turnIndex: 0,
        prompt: "First turn",
        votable: false,
        vote: "left",
        models: {
          A: { id: slotA.id, displayName: slotA.displayName },
          B: { id: slotB.id, displayName: slotB.displayName },
        },
      });
      expect(body.turns[0].answers).toEqual([
        { slot: "A", content: "Answer from alpha", error: null },
        { slot: "B", content: "Answer from beta", error: null },
      ]);
      // The open turn's answers are readable; its identities are not.
      expect(body.turns[1]).toMatchObject({
        turnIndex: 1,
        prompt: "Follow up",
        votable: true,
        vote: null,
        models: null,
      });
      expect(JSON.stringify(body.turns[1])).not.toContain(slotA.displayName);
    } finally {
      await app.close();
    }
  });

  it("answers another session's conversation with a 403", async () => {
    const { app } = await setup();
    try {
      const chat = await start(app, {
        prompt: "Private",
        sessionId: "anon_owner",
      });
      const conversationId = parseEvents(chat.body)[0]
        ?.conversationId as string;

      const stranger = await app.inject({
        method: "GET",
        url: `/api/arena/conversations/${conversationId}?sessionId=anon_stranger`,
      });
      expect(stranger.statusCode).toBe(403);

      const missing = await app.inject({
        method: "GET",
        url: "/api/arena/conversations/00000000-0000-4000-8000-0000000000ff",
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("echoes an AG-UI client's own run ids without moving the slot channel", async () => {
    const { app } = await setup();
    try {
      const chat = await app.inject({
        method: "POST",
        url: "/api/arena/chat?protocol=ag-ui",
        payload: {
          threadId: "client-thread",
          runId: "client-run",
          messages: [{ id: "m1", role: "user", content: "Hello" }],
          forwardedProps: { sessionId: "anon_correlate" },
        },
      });
      const events = parseEvents(chat.body);
      const matchupId = (
        events.find((event) => event.name === "arena_matchup")?.value as {
          matchupId: string;
        }
      ).matchupId;

      for (const type of ["RUN_STARTED", "RUN_FINISHED"]) {
        expect(events.find((event) => event.type === type)).toMatchObject({
          threadId: "client-thread",
          runId: "client-run",
        });
      }
      // Slot identity still travels on `<matchupId>:<slot>`, which is what
      // clients parse; echoing the run id must not move that channel.
      expect(
        events
          .filter((event) => event.type === "TEXT_MESSAGE_START")
          .map((event) => event.messageId),
      ).toEqual([`${matchupId}:A`, `${matchupId}:B`]);
    } finally {
      await app.close();
    }
  });
});

/**
 * Slot join: one matchup served over two sibling requests, the shape a client
 * with a compare view sends when it fans a turn out into one request per model.
 * The reference case is Open WebUI v0.10, whose parallel requests share a
 * `chat_id` and repeat the same messages.
 */
describe("slot join", () => {
  const joinPayload = (overrides: Record<string, unknown> = {}) => ({
    prompt: "Compare these two",
    sessionId: "anon_join",
    joinKey: "chat-7f3a",
    ...overrides,
  });

  const chat = (
    app: Awaited<ReturnType<typeof setup>>["app"],
    payload: Record<string, unknown>,
  ) => app.inject({ method: "POST", url: "/api/arena/chat", payload });

  it("serves two simultaneous siblings as one matchup with one vote", async () => {
    const { app, repository, receivedMessages } = await setup();
    try {
      // Dispatched in the same tick, as a fan-out does: whichever the loop runs
      // first becomes the leader, and exactly one of them does.
      const [first, second] = await Promise.all([
        chat(app, joinPayload()),
        chat(app, joinPayload()),
      ]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      const started = [first, second].map((reply) => parseEvents(reply.body)[0]);
      const leader = started.find((event) => event?.matchupToken);
      expect(new Set(started.map((event) => event?.matchupId)).size).toBe(1);
      expect(started.map((event) => event?.slots).sort()).toEqual([
        ["A"],
        ["B"],
      ]);
      // Both siblings can vote on the shared matchup; the single-vote rule
      // decides which one counts.
      for (const event of started) {
        expect(event).toMatchObject({ mode: "matchup", votable: true });
        expect(event?.matchupToken).toBe(leader?.matchupToken);
        expect(event?.conversationId).toBe(leader?.conversationId);
      }

      // Each connection carries only its own slot, and the two are disjoint.
      const slotsOf = (body: string) =>
        new Set(
          parseEvents(body)
            .filter((event) => event.type === "token")
            .map((event) => event.slot),
        );
      expect([...slotsOf(first.body)]).toHaveLength(1);
      expect([...slotsOf(second.body)]).toHaveLength(1);
      expect([...slotsOf(first.body)]).not.toEqual([...slotsOf(second.body)]);
      for (const reply of [first, second]) {
        expect(parseEvents(reply.body).at(-1)).toMatchObject({
          type: "matchup_done",
        });
      }

      // One matchup row, one generation per model, both responses persisted.
      expect(repository.matchups.size).toBe(1);
      expect(receivedMessages).toHaveLength(2);
      expect(repository.responses).toHaveLength(2);
      expect(repository.responses.map((response) => response.slot).sort()).toEqual(
        ["A", "B"],
      );

      const matchupId = leader?.matchupId as string;
      const matchupToken = leader?.matchupToken as string;
      const vote = await app.inject({
        method: "POST",
        url: "/api/arena/vote",
        payload: { matchupId, matchupToken, vote: "left" },
      });
      expect(vote.statusCode).toBe(200);
      const duplicate = await app.inject({
        method: "POST",
        url: "/api/arena/vote",
        payload: { matchupId, matchupToken, vote: "right" },
      });
      expect(duplicate.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("keeps both identities off both siblings' connections", async () => {
    const { app } = await setup();
    try {
      const replies = await Promise.all([
        chat(app, joinPayload()),
        chat(app, joinPayload()),
      ]);

      for (const reply of replies) {
        expect(reply.body).not.toContain(slotA.displayName);
        expect(reply.body).not.toContain(slotB.displayName);
        expect(reply.body).not.toContain(slotA.id);
        expect(reply.body).not.toContain(slotB.id);
      }
    } finally {
      await app.close();
    }
  });

  it("runs both slots on one connection when the window closes unpaired", async () => {
    const { app, repository } = await setup(undefined, {
      joinBroker: new JoinBroker({
        windowMs: 20,
        maxPending: 8,
        maxQueuedEvents: 64,
      }),
    });
    try {
      const lone = await chat(app, joinPayload());

      // Degrading to today's exact shape is what keeps the vote honest: the
      // user sees both answers either way, and nothing is generated in vain.
      expect(lone.statusCode).toBe(200);
      const started = parseEvents(lone.body)[0];
      expect(started).toMatchObject({
        mode: "matchup",
        votable: true,
        slots: ["A", "B"],
      });
      expect(repository.responses).toHaveLength(2);

      // The sibling that shows up after the window is told so, rather than
      // silently opening a second matchup for the same turn.
      const late = await chat(app, joinPayload());
      expect(late.statusCode).toBe(409);
      expect(late.json().error).toContain("join window closed");
    } finally {
      await app.close();
    }
  });

  it("refuses a third request on a scope whose slots are taken", async () => {
    const { app, repository } = await setup();
    try {
      await Promise.all([chat(app, joinPayload()), chat(app, joinPayload())]);
      const third = await chat(app, joinPayload());

      expect(third.statusCode).toBe(409);
      expect(repository.matchups.size).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("refuses a join it cannot scope to a session", async () => {
    const { app, repository } = await setup();
    try {
      const unscoped = await chat(app, {
        prompt: "Compare these two",
        joinKey: "chat-7f3a",
      });

      expect(unscoped.statusCode).toBe(400);
      expect(unscoped.json().error).toContain("sessionId");
      expect(repository.matchups.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it.each([
    ["session", { sessionId: "anon_attacker" }],
    ["prompt", { prompt: "Compare these two, please" }],
  ])(
    "never attaches a request that forges the join key with the wrong %s",
    async (_label, override: Record<string, unknown>) => {
      // Neither request can pair, so both wait out the window: keep it short.
      const { app, repository } = await setup(undefined, {
        joinBroker: new JoinBroker({
          windowMs: 20,
          maxPending: 8,
          maxQueuedEvents: 64,
        }),
      });
      try {
        const [victim, intruder] = await Promise.all([
          chat(app, joinPayload()),
          chat(app, joinPayload(override)),
        ]);

        // Knowing the join key buys nothing: the capability is the whole scope,
        // so the intruder gets its own matchup and never sees a byte of the
        // victim's slot.
        const [victimStart, intruderStart] = [victim, intruder].map(
          (reply) => parseEvents(reply.body)[0],
        );
        expect(victimStart?.matchupId).not.toBe(intruderStart?.matchupId);
        expect(intruder.body).not.toContain(victimStart?.matchupId as string);
        expect(victimStart).toMatchObject({ slots: ["A", "B"] });
        expect(intruderStart).toMatchObject({ slots: ["A", "B"] });
        expect(repository.matchups.size).toBe(2);
      } finally {
        await app.close();
      }
    },
  );

  it("ignores a joinKey when joining is disabled", async () => {
    const { app, repository } = await setup(undefined, {
      joinBroker: new JoinBroker({
        windowMs: 0,
        maxPending: 8,
        maxQueuedEvents: 64,
      }),
    });
    try {
      const [first, second] = await Promise.all([
        chat(app, joinPayload()),
        chat(app, joinPayload()),
      ]);

      for (const reply of [first, second]) {
        expect(parseEvents(reply.body)[0]).toMatchObject({
          slots: ["A", "B"],
        });
      }
      expect(repository.matchups.size).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("carries a join through a protocol's own envelope", async () => {
    const { app, repository } = await setup();
    try {
      const openAiBody = () => ({
        model: "omni-arena",
        messages: [{ role: "user", content: "Compare these two" }],
        omni_arena: { sessionId: "anon_openai_join", joinKey: "chat-9c1" },
      });

      const replies = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/arena/chat?protocol=openai",
          payload: openAiBody(),
        }),
        app.inject({
          method: "POST",
          url: "/api/arena/chat?protocol=openai",
          payload: openAiBody(),
        }),
      ]);

      for (const reply of replies) {
        expect(reply.statusCode).toBe(200);
      }
      // One matchup for the pair: this is the shape that lets a strictly
      // OpenAI-compatible compare view feed the rating engine real pairs.
      expect(repository.matchups.size).toBe(1);
      expect(repository.responses).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("reports the leader's pre-stream failure to its sibling", async () => {
    const { app } = await setup();
    try {
      const orphan = "11111111-2222-4000-8000-333333333333";
      const [first, second] = await Promise.all([
        chat(app, joinPayload({ conversationId: orphan })),
        chat(app, joinPayload({ conversationId: orphan })),
      ]);

      // Both halves of one turn must fail the same way; a sibling parked on a
      // matchup that was never created would otherwise hang.
      for (const reply of [first, second]) {
        expect(reply.statusCode).toBe(404);
        expect(reply.json().error).toBe("Conversation not found");
      }
    } finally {
      await app.close();
    }
  });
});
