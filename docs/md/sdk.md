# SDK

`@omni-arena/react` is the published, **headless** React SDK for OmniArena:
blind side-by-side LLM comparisons over one SSE stream, blind voting with
identity reveal, multi-turn continuation from the winning response, and the
Bradley-Terry leaderboard. No UI, no styling — just state and actions. Bring
your own components.

The SDK lives in the `packages/react-sdk/` workspace and is the single source of
truth for the arena hooks; the demo app in `web/` is its reference consumer.

Related: [Architecture](architecture.md) · [API](api.md) · [Integration](integration.md) · [Rating methodology](rating-methodology.md) · [Data model](data-model.md) · [Setup](setup.md)

## Install

```bash
npm install @omni-arena/react react
```

`react` (>=18) is a peer dependency.

## Exports

```ts
import {
  useArenaChat,
  useArenaLeaderboard,
  type ArenaSlot,
  type ArenaVote,
  type SlotState,
  type RevealedModel,
  type LeaderboardModel,
  type UseArenaChatOptions,
  type UseArenaLeaderboardOptions,
} from "@omni-arena/react";
```

Two hooks and their public types. `ArenaSlot` is `"A" | "B"`; `ArenaVote` is
`"left" | "right" | "both_good" | "both_bad" | "skip"`.

## `useArenaChat(options?)`

Starts and continues matchups, streams both responses into per-slot state, and
records votes.

Returns:

| Field | Type | Description |
|---|---|---|
| `sendPrompt(prompt)` | `(string) => Promise<void>` | Start or continue a matchup; streams tokens into `slots`. |
| `vote(vote)` | `(ArenaVote) => Promise<void>` | Record a vote and reveal identities. |
| `resetConversation()` | `() => void` | Abort any stream and clear all state. |
| `slots` | `Record<ArenaSlot, SlotState>` | Per-slot `content`, `status` (`idle`/`streaming`/`done`/`error`), and `error`. |
| `isStreaming` | `boolean` | A matchup is currently streaming. |
| `canVote` | `boolean` | A matchup is ready to be voted on. |
| `revealedModels` | `Record<ArenaSlot, RevealedModel> \| undefined` | Model identities, available only after voting. |
| `conversationId` | `string \| undefined` | The active multi-turn conversation, if any. |
| `error` | `string \| null` | Last request error. |

The hook manages an anonymous session id in `localStorage` and continues a
conversation only after a decisive `left`/`right` vote (matching the server's
linear-history rules — see [API](api.md)).

## `useArenaLeaderboard(options?)`

Fetches standings once on mount and exposes a `refresh()` to call after a vote.

Returns `{ models: LeaderboardModel[]; refresh(): Promise<void>; error: string | null }`.
`LeaderboardModel` carries win/loss/tie/skip counts, `winRate`, and the optional
worker-computed `rating*` and `styleControlled*` fields (see
[API → leaderboard](api.md)).

## The `baseUrl` option

Both hooks take `options.baseUrl?: string` — the origin (or path prefix) the
arena API is served from. It defaults to `""`, so requests hit the same-origin
`/api/arena/*` routes (e.g. behind a dev proxy that forwards `/api/arena/*`, as
the demo does). Pass an absolute origin to target a remote server:

```ts
useArenaChat({ baseUrl: "https://arena.example.com" });
useArenaLeaderboard({ baseUrl: "https://arena.example.com" });
```

## Integration example

A full blind-comparison-and-vote flow in under ten lines — bring your own
markup:

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

The demo app `web/src/App.tsx` is the reference consumer: it wires the same two
hooks into a prompt box, two anonymous markdown panes, five vote buttons, the
identity reveal, and the leaderboard.
