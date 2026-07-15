import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  ChatMessage,
  LeaderboardEntry,
  LeaderboardPort,
  MatchupRecord,
  Model,
  PreferenceRecord,
  PreferenceRepositoryPort,
  ResponseRecord,
} from "../core/ports.js";

interface ModelRow {
  id: string;
  display_name: string;
  provider: string;
  provider_model_id: string;
  enabled: boolean;
}

function mapModel(row: ModelRow): Model {
  return {
    id: row.id,
    displayName: row.display_name,
    provider: row.provider,
    providerModelId: row.provider_model_id,
    enabled: row.enabled,
  };
}

export class DuplicateVoteError extends Error {
  constructor() {
    super("A vote has already been recorded for this matchup");
  }
}

export class ConversationConflictError extends Error {
  constructor() {
    super("The conversation has already advanced from this response");
  }
}

export class PostgresRepository
  implements PreferenceRepositoryPort, LeaderboardPort
{
  constructor(private readonly pool: Pool) {}

  async listEnabledModels(): Promise<Model[]> {
    const result = await this.pool.query<ModelRow>(
      `SELECT id, display_name, provider, provider_model_id, enabled
       FROM models
       WHERE enabled = TRUE
       ORDER BY created_at, id`,
    );
    return result.rows.map(mapModel);
  }

  async createMatchup(matchup: MatchupRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (matchup.conversation.turnIndex === 0) {
        await client.query(
          `INSERT INTO conversations (id, anonymous_session_id)
           VALUES ($1, $2)`,
          [
            matchup.conversation.id,
            matchup.conversation.anonymousSessionId,
          ],
        );
      } else {
        const latest = await client.query<{
          turn_index: number;
          winner_response_id: string | null;
        }>(
          `SELECT
             t.turn_index,
             winner.id AS winner_response_id
           FROM turns t
           LEFT JOIN preferences p ON p.matchup_id = t.matchup_id
           LEFT JOIN responses winner
             ON winner.matchup_id = t.matchup_id
             AND winner.model_id = p.winner_model_id
           WHERE t.conversation_id = $1
           ORDER BY t.turn_index DESC
           LIMIT 1`,
          [matchup.conversation.id],
        );
        const previous = latest.rows[0];
        if (
          !previous ||
          previous.turn_index !== matchup.conversation.turnIndex - 1 ||
          previous.winner_response_id !==
            matchup.conversation.parentResponseId
        ) {
          throw new ConversationConflictError();
        }
      }

      await client.query(
        `INSERT INTO matchups (
          id, prompt, model_a_id, model_b_id, slot_a_model_id,
          slot_b_model_id, matchup_token_hash, harness_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          matchup.id,
          matchup.prompt,
          matchup.modelAId,
          matchup.modelBId,
          matchup.slotAModelId,
          matchup.slotBModelId,
          matchup.matchupTokenHash,
          matchup.harnessVersion,
        ],
      );
      await client.query(
        `INSERT INTO turns (
          id, conversation_id, matchup_id, parent_response_id,
          turn_index, prompt
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          matchup.conversation.turnId,
          matchup.conversation.id,
          matchup.id,
          matchup.conversation.parentResponseId,
          matchup.conversation.turnIndex,
          matchup.prompt,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new ConversationConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async saveResponse(response: ResponseRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO responses (
        id, matchup_id, slot, model_id, content, latency_ms,
        ttft_ms, stream_duration_ms, output_token_count,
        token_count_source, markdown_density, model_version, error
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      )
      ON CONFLICT (matchup_id, slot) DO NOTHING`,
      [
        randomUUID(),
        response.matchupId,
        response.slot,
        response.modelId,
        response.content,
        response.latencyMs,
        response.ttftMs,
        response.streamDurationMs,
        response.outputTokenCount,
        response.tokenCountSource,
        response.markdownDensity,
        response.modelVersion,
        response.error,
      ],
    );
  }

  async recordPreference(preference: PreferenceRecord): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO preferences (
          id, matchup_id, vote, winner_model_id,
          position_bias_meta, anonymous_session_id
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          preference.matchupId,
          preference.vote,
          preference.winnerModelId,
          JSON.stringify(preference.positionBiasMeta),
          preference.anonymousSessionId,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new DuplicateVoteError();
      }
      throw error;
    }
  }

  async getConversationContext(
    conversationId: string,
    anonymousSessionId: string | null,
  ): Promise<
    | {
        status: "ready";
        conversationId: string;
        nextTurnIndex: number;
        parentResponseId: string;
        messages: ChatMessage[];
      }
    | { status: "not_found" }
    | { status: "forbidden" }
    | { status: "not_ready" }
  > {
    const result = await this.pool.query<{
      anonymous_session_id: string | null;
      turn_index: number;
      prompt: string;
      winner_response_id: string | null;
      winner_content: string | null;
    }>(
      `SELECT
        c.anonymous_session_id,
        t.turn_index,
        t.prompt,
        winner.id AS winner_response_id,
        winner.content AS winner_content
      FROM conversations c
      JOIN turns t ON t.conversation_id = c.id
      LEFT JOIN preferences p ON p.matchup_id = t.matchup_id
      LEFT JOIN responses winner
        ON winner.matchup_id = t.matchup_id
        AND winner.model_id = p.winner_model_id
      WHERE c.id = $1
      ORDER BY t.turn_index`,
      [conversationId],
    );
    if (result.rows.length === 0) {
      return { status: "not_found" };
    }
    if (result.rows[0]?.anonymous_session_id !== anonymousSessionId) {
      return { status: "forbidden" };
    }

    const latest = result.rows.at(-1);
    if (!latest?.winner_response_id || latest.winner_content === null) {
      return { status: "not_ready" };
    }

    const messages: ChatMessage[] = [];
    for (const row of result.rows) {
      if (!row.winner_response_id || row.winner_content === null) {
        return { status: "not_ready" };
      }
      messages.push(
        { role: "user", content: row.prompt },
        { role: "assistant", content: row.winner_content },
      );
    }

    return {
      status: "ready",
      conversationId,
      nextTurnIndex: latest.turn_index + 1,
      parentResponseId: latest.winner_response_id,
      messages,
    };
  }

  async getMatchup(matchupId: string): Promise<{
    id: string;
    matchupTokenHash: string;
    slotA: Model;
    slotB: Model;
  } | null> {
    const result = await this.pool.query<
      ModelRow & {
        matchup_id: string;
        matchup_token_hash: string;
        b_id: string;
        b_display_name: string;
        b_provider: string;
        b_provider_model_id: string;
        b_enabled: boolean;
      }
    >(
      `SELECT
        mt.id AS matchup_id,
        mt.matchup_token_hash,
        a.id,
        a.display_name,
        a.provider,
        a.provider_model_id,
        a.enabled,
        b.id AS b_id,
        b.display_name AS b_display_name,
        b.provider AS b_provider,
        b.provider_model_id AS b_provider_model_id,
        b.enabled AS b_enabled
      FROM matchups mt
      JOIN models a ON a.id = mt.slot_a_model_id
      JOIN models b ON b.id = mt.slot_b_model_id
      WHERE mt.id = $1`,
      [matchupId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.matchup_id,
      matchupTokenHash: row.matchup_token_hash,
      slotA: mapModel(row),
      slotB: mapModel({
        id: row.b_id,
        display_name: row.b_display_name,
        provider: row.b_provider,
        provider_model_id: row.b_provider_model_id,
        enabled: row.b_enabled,
      }),
    };
  }

  async getLeaderboard(): Promise<LeaderboardEntry[]> {
    const result = await this.pool.query<{
      id: string;
      display_name: string;
      wins: string;
      losses: string;
      ties: string;
      skips: string;
      total_votes: string;
    }>(
      `SELECT
        m.id,
        m.display_name,
        SUM(CASE
          WHEN p.winner_model_id = m.id THEN 1 ELSE 0
        END) AS wins,
        SUM(CASE
          WHEN p.vote IN ('left', 'right')
            AND p.winner_model_id <> m.id
          THEN 1 ELSE 0
        END) AS losses,
        SUM(CASE
          WHEN p.vote IN ('both_good', 'both_bad') THEN 1 ELSE 0
        END) AS ties,
        SUM(CASE WHEN p.vote = 'skip' THEN 1 ELSE 0 END) AS skips,
        COUNT(p.id) AS total_votes
      FROM models m
      LEFT JOIN matchups mt
        ON m.id = mt.slot_a_model_id OR m.id = mt.slot_b_model_id
      LEFT JOIN preferences p ON p.matchup_id = mt.id
      WHERE m.enabled = TRUE
      GROUP BY m.id, m.display_name
      ORDER BY wins DESC, total_votes DESC, m.display_name`,
    );

    return result.rows.map((row) => {
      const wins = Number(row.wins);
      const losses = Number(row.losses);
      const ties = Number(row.ties);
      const denominator = wins + losses + ties;
      return {
        id: row.id,
        displayName: row.display_name,
        wins,
        losses,
        ties,
        skips: Number(row.skips),
        totalVotes: Number(row.total_votes),
        winRate: denominator === 0 ? 0 : wins / denominator,
      };
    });
  }
}
