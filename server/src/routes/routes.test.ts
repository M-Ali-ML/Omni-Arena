import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
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
          slotA,
          slotB,
        }
      : null;
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
    .filter((data): data is string => Boolean(data))
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

async function setup() {
  const repository = new MemoryRepository();
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
  });
  return { app, repository, receivedMessages };
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
