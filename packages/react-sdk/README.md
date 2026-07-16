# @omni-arena/react

Headless React hooks for [OmniArena](../../README.md): blind side-by-side LLM
comparisons over a single SSE stream, blind voting with identity reveal,
multi-turn continuation from the winning response, and the Bradley-Terry
leaderboard.

No UI, no styling — just state and actions. Bring your own components.

## Install

```bash
npm install @omni-arena/react react
```

`react` (>=18) is a peer dependency.

## Quick start

A full blind-comparison-and-vote flow in ten lines — bring your own markup:

```tsx
import { useArenaChat } from "@omni-arena/react";

export function Arena() {
  const { sendPrompt, slots, canVote, vote } = useArenaChat();
  return (
    <div>
      <button onClick={() => sendPrompt("Explain quantum tunneling")}>Ask</button>
      <pre>{slots.A.content}</pre><pre>{slots.B.content}</pre>
      <button disabled={!canVote} onClick={() => vote("left")}>A wins</button>
    </div>
  );
}
```

Pass `useArenaChat({ baseUrl: "https://arena.example.com" })` to target a remote
server; omit it (or pass `""`) when the arena API is same-origin, e.g. behind a
dev proxy that forwards `/api/arena/*`. `useArenaLeaderboard()` takes the same
option and returns `{ models, refresh, error }`.

## API

### `useArenaChat(options?)`

`options.baseUrl?: string` — origin/path prefix for the arena API (default `""`).

Returns:

| Field | Type | Description |
| --- | --- | --- |
| `sendPrompt(prompt)` | `(string) => Promise<void>` | Start or continue a matchup; streams tokens into `slots`. |
| `vote(vote)` | `(ArenaVote) => Promise<void>` | Record a vote (`"left" \| "right" \| "both_good" \| "both_bad" \| "skip"`) and reveal identities. |
| `resetConversation()` | `() => void` | Abort any stream and clear all state. |
| `slots` | `Record<ArenaSlot, SlotState>` | Per-slot `content`, `status`, and `error`. |
| `isStreaming` | `boolean` | A matchup is currently streaming. |
| `canVote` | `boolean` | A matchup is ready to be voted on. |
| `revealedModels` | `Record<ArenaSlot, RevealedModel> \| undefined` | Model identities, available after voting. |
| `conversationId` | `string \| undefined` | The active multi-turn conversation, if any. |
| `error` | `string \| null` | Last request error. |

### `useArenaLeaderboard(options?)`

`options.baseUrl?: string` — origin/path prefix for the arena API (default `""`).

Returns `{ models: LeaderboardModel[]; refresh(): Promise<void>; error: string | null }`.
Fetches once on mount; call `refresh()` after a vote to update the standings.

## Types

`ArenaSlot`, `ArenaVote`, `SlotState`, `RevealedModel`, `LeaderboardModel`,
`UseArenaChatOptions`, and `UseArenaLeaderboardOptions` are all exported.
