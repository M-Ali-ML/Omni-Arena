"use client";

import { ShuffleIcon, TrophyIcon } from "lucide-react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { fetcher } from "@/lib/utils";
import { useArena } from "./arena-provider";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type LeaderboardRow = {
  id: string;
  displayName: string;
  wins: number;
  losses: number;
  ties: number;
  totalVotes: number;
  winRate: number;
  rating: number | null;
};

/**
 * Stands in for the template's model picker. OmniArena's chat API takes no model
 * hint — matchmaking picks the pair (or the single model) from its own enabled
 * roster — so there is nothing for the picker to select.
 *
 * It replaces the picker rather than dimming it, because a dimmed picker still
 * *names a model*, and a model name in the composer of a blind matchup reads as
 * "this is who is answering you" — the one thing a pre-vote screen must not say.
 * So the label names who chose instead of what was chosen.
 */
export function ArenaModelLock() {
  return (
    <span
      className="flex h-7 max-w-[220px] items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground"
      data-testid="arena-model-lock"
      title="OmniArena picks the models for each matchup; edit its roster with server/src/db/seed.ts"
    >
      <ShuffleIcon className="size-3.5 shrink-0" />
      <span className="truncate">Models chosen by the arena</span>
    </span>
  );
}

/**
 * Asks OmniArena to compare two models for the next message. Whether the
 * request actually becomes a matchup is the arena's decision (see ARENA_TRIGGER)
 * — this is the opt-in signal, not an override.
 */
export function ArenaModeToggle() {
  const { enabled, setEnabled } = useArena();

  return (
    <Button
      aria-pressed={enabled}
      data-testid="arena-toggle"
      onClick={() => setEnabled(!enabled)}
      size="sm"
      title="Compare two anonymous models and vote on the better answer"
      variant={enabled ? "default" : "outline"}
    >
      {enabled ? "Compare: on" : "Compare: off"}
    </Button>
  );
}

export function ArenaLeaderboard() {
  // Fetched lazily: SWR only runs once the popover mounts its content.
  const { data, error, isLoading } = useSWR<{ models: LeaderboardRow[] }>(
    `${basePath}/api/arena/leaderboard`,
    fetcher,
    { revalidateOnFocus: false },
  );

  if (isLoading) {
    return <p className="text-[12px] text-muted-foreground">Loading…</p>;
  }
  if (error || !data) {
    return (
      <p className="text-[12px] text-destructive">
        Could not load the leaderboard.
      </p>
    );
  }
  if (data.models.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground">No models enabled yet.</p>
    );
  }

  return (
    <ul className="flex flex-col gap-2" data-testid="arena-leaderboard">
      {data.models.map((model) => (
        <li
          className="flex items-baseline justify-between gap-4 text-[12px]"
          data-testid="arena-leaderboard-row"
          key={model.id}
        >
          <span className="truncate">{model.displayName}</span>
          <span className="shrink-0 text-muted-foreground">
            {model.rating === null
              ? `${Math.round(model.winRate * 100)}% win rate`
              : `${Math.round(model.rating)} BT`}
            {` · ${model.wins}W/${model.losses}L/${model.ties}T`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ArenaLeaderboardButton() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          data-testid="arena-leaderboard-open"
          size="icon-sm"
          variant="ghost"
        >
          <TrophyIcon className="size-4" />
          <span className="sr-only">Arena leaderboard</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="mb-2 font-medium text-[12px]">Arena leaderboard</p>
        <ArenaLeaderboard />
      </PopoverContent>
    </Popover>
  );
}
