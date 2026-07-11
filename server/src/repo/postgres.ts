import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
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
    await this.pool.query(
      `INSERT INTO matchups (
        id, prompt, model_a_id, model_b_id, slot_a_model_id,
        slot_b_model_id, matchup_token_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        matchup.id,
        matchup.prompt,
        matchup.modelAId,
        matchup.modelBId,
        matchup.slotAModelId,
        matchup.slotBModelId,
        matchup.matchupTokenHash,
      ],
    );
  }

  async saveResponse(response: ResponseRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO responses (
        id, matchup_id, slot, model_id, content, latency_ms, error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (matchup_id, slot) DO NOTHING`,
      [
        randomUUID(),
        response.matchupId,
        response.slot,
        response.modelId,
        response.content,
        response.latencyMs,
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
