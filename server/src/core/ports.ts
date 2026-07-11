import type { ArenaSlot } from "./events.js";

export type ArenaVote =
  | "left"
  | "right"
  | "both_good"
  | "both_bad"
  | "skip";

export interface Model {
  id: string;
  displayName: string;
  provider: string;
  providerModelId: string;
  enabled: boolean;
}

export interface ModelProviderPort {
  stream(model: Model, prompt: string): AsyncIterable<string>;
}

export interface ProviderResolverPort {
  resolve(provider: string): ModelProviderPort;
}

export interface MatchupAssignment {
  modelA: Model;
  modelB: Model;
  slotA: Model;
  slotB: Model;
}

export interface MatchmakingPort {
  pick(): Promise<MatchupAssignment>;
}

export interface MatchupRecord {
  id: string;
  prompt: string;
  modelAId: string;
  modelBId: string;
  slotAModelId: string;
  slotBModelId: string;
  matchupTokenHash: string;
}

export interface ResponseRecord {
  matchupId: string;
  slot: ArenaSlot;
  modelId: string;
  content: string;
  latencyMs: number;
  error: string | null;
}

export interface PreferenceRecord {
  matchupId: string;
  vote: ArenaVote;
  winnerModelId: string | null;
  positionBiasMeta: Record<string, unknown>;
  anonymousSessionId: string | null;
}

export interface PreferenceRepositoryPort {
  listEnabledModels(): Promise<Model[]>;
  createMatchup(matchup: MatchupRecord): Promise<void>;
  saveResponse(response: ResponseRecord): Promise<void>;
  recordPreference(preference: PreferenceRecord): Promise<void>;
  getMatchup(matchupId: string): Promise<{
    id: string;
    matchupTokenHash: string;
    slotA: Model;
    slotB: Model;
  } | null>;
}

export interface LeaderboardEntry {
  id: string;
  displayName: string;
  wins: number;
  losses: number;
  ties: number;
  skips: number;
  totalVotes: number;
  winRate: number;
}

export interface LeaderboardPort {
  getLeaderboard(): Promise<LeaderboardEntry[]>;
}
