# @omni-arena/react

Headless React hooks for
[OmniArena](https://github.com/M-Ali-ML/Omni-Arena): blind side-by-side LLM
comparisons over a single SSE stream, blind voting with identity reveal,
multi-turn continuation from the winning response, and the Bradley-Terry
leaderboard.

No UI, no styling — just state and actions. Bring your own components.

Two layers, depending on who owns the conversation state:

- **Primitives** (`getSessionId`, `submitArenaVote`, `createArenaSseDecoder`,
  the wire types) — stateless and React-free, for a host chat app whose own
  runtime already owns the connection, the stream, and the persisted messages.
- **`useArenaChat`** — the all-in-one hook for a greenfield app. Built on the
  primitives, so there is one implementation of each piece.

## Install

This is a workspace package under `packages/react-sdk/`. From another package
in this monorepo, depend on it the same way `web/` does:

```json
{
  "dependencies": {
    "@omni-arena/react": "*"
  }
}
```

`react` (>=18) is a peer dependency. Once the package is published to npm, the
public install will be `npm install @omni-arena/react react`.

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
dev proxy that forwards `/api/arena/*`. Every other hook here takes the same
option.

## Primitives for host apps

If you already have a chat app — Vercel AI Chatbot's `useChat`, assistant-ui's
runtime, CopilotKit, your own — it owns the message store that gets persisted,
auth-gated, and replayed. Don't hand that over to `useArenaChat`; compose these
instead. All of them are stateless and safe to call from a server route.

| Export | Purpose |
| --- | --- |
| `getSessionId(options?)` | The anonymous session id the arena ties conversation ownership to. Persisted under `ARENA_SESSION_STORAGE_KEY` (`"omni-arena-session"`, exported so a host can read or clear the same slot); `{ storage, key, prefix }` relocates it, and it works where there is no storage. |
| `submitArenaVote({ matchupId, matchupToken, vote, baseUrl?, signal? })` | `POST /api/arena/vote` as a plain async function. Resolves with the `ArenaReveal`, rejects with the server's message. |
| `useArenaVote({ baseUrl?, matchupId?, matchupToken? })` | Thin hook around it: `{ vote, reset, reveal, isVoting, error, canVote }`. `vote(choice, target?)` returns `null` on failure with the message in `error` instead of throwing. |
| `createArenaSseDecoder<T>()` | Incremental SSE decoder — `push(chunk)` / `flush()` — handling CRLF, multi-line `data:`, split multi-byte characters, and `data: [DONE]`. |
| `readArenaStream<T>(response)` | The same decoder as an `for await` iterator. |
| `parseArenaMatchup` / `parseArenaReveal` / `parseArenaSlotError` | Normalise a round, a reveal, or a slot failure out of any adapter's payload. |
| `isDecisiveVote(vote)` | Whether the next turn may continue the conversation (only `left`/`right` may). |

```ts
import { getSessionId, parseArenaMatchup, readArenaStream } from "@omni-arena/react";

const response = await fetch("https://arena.example.com/api/arena/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt, sessionId: getSessionId() }),
});

for await (const event of readArenaStream(response)) {
  if (event.type === "matchup_started") {
    const round = parseArenaMatchup(event);
    // round.matchupToken is null when there is nothing to vote on, and
    // round.conversationId is absent when there is nothing to continue.
  }
}
```

## API

### `useArenaChat(options?)`

`options.baseUrl?: string` — origin/path prefix for the arena API (default `""`).

Returns:

| Field | Type | Description |
| --- | --- | --- |
| `sendPrompt(prompt)` | `(string) => Promise<void>` | Start or continue a matchup; streams tokens into `slots`. |
| `vote(vote)` | `(ArenaVote) => Promise<void>` | Record a vote (`"left" \| "right" \| "both_good" \| "both_bad" \| "skip"`) and reveal identities. |
| `stop()` | `() => Promise<void>` | Cancel the running matchup over the WebSocket control plane (`/api/arena/control`), then settle the slots locally — the server aborts by closing the stream, so no terminal event arrives. The socket is opened lazily on the first call; failures land in `error` instead of throwing, so a stop button can call it directly. |
| `resetConversation()` | `() => void` | Abort any stream, close the control socket, and clear all state. |
| `slots` | `Record<ArenaSlot, SlotState>` | Per-slot `content`, `status`, and `error`. |
| `isStreaming` | `boolean` | A matchup is currently streaming. |
| `canVote` | `boolean` | A matchup is ready to be voted on. |
| `revealedModels` | `Record<ArenaSlot, RevealedModel> \| undefined` | Model identities, available after voting. |
| `conversationId` | `string \| undefined` | The active multi-turn conversation, if any. |
| `error` | `string \| null` | Last request error. |

### `useArenaLeaderboard(options?)`

`options.baseUrl?: string` — origin/path prefix for the arena API (default `""`).

Returns:

| Field | Type | Description |
| --- | --- | --- |
| `models` | `LeaderboardModel[]` | The standings. Each row carries the raw record (`wins`/`losses`/`ties`/`skips`/`winRate`) plus the Bradley-Terry `rating`, its standard error and confidence interval, the `componentId` of the comparison graph it belongs to, and the style-controlled trio — all of them `null` until the rating worker has run. |
| `components` | `LeaderboardComponents` | Connectivity of the comparison graph. Ratings are identified only up to a per-component constant, so rows from different `componentId`s must not be compared; `count` is `null` before the worker runs. |
| `styleControl` | `StyleControlReport` | The style confounders the worker regressed out, on the same display scale as `rating`, with the vote count they were fitted on. Empty until the style pass has run. |
| `refresh()` | `() => Promise<void>` | Re-fetch the standings. |
| `error` | `string \| null` | Last request error. |

Fetches once on mount; call `refresh()` after a vote to update the standings.
Both context fields are optional on the wire, so the hook falls back to empty
values against a server that predates them rather than failing.

### Analytics hooks

Six hooks over the server's `/api/arena/analytics/*` routes — the same data the
bundled insights dashboard renders. Each fetches once on mount and returns the
same `AnalyticsResource<T>` shape: `{ data, refresh, error }`, with `data` null
until the first response lands.

| Hook | Route | `data` |
| --- | --- | --- |
| `useArenaSummary()` | `summary` | `ArenaSummary` — totals, the vote breakdown, slot A/B win counts, and pair coverage. |
| `useArenaHeadToHead()` | `head-to-head` | `HeadToHeadStats` — every sampled pair's record, plus the models to label it with. |
| `useArenaModelMetrics()` | `model-metrics` | `{ models: ModelMetricsEntry[] }` — latency percentiles, mean output tokens, markdown density and per-slot records. The route wraps its rows, so read `data.models`; the other five hooks hand back the payload directly. |
| `useArenaActivity({ bucket? })` | `activity?bucket=day\|hour` | `ActivityStats` — votes and cumulative games per bucket (`"day"` by default). |
| `useArenaStyleControl()` | `style-control` | `StyleControlStats` — the fitted style coefficients and each model's rating beside its style-controlled one. |
| `useArenaRatingHistory({ since? })` | `rating-history` | `RatingHistoryStats` — rating snapshots with intervals over time; `since` is an ISO 8601 lower bound. |

These routes only exist when the server was built with an analytics port, so a
deployment without one answers 404 and the hooks report it in `error`.

## Types

`ArenaSlot`, `ArenaVote`, `ArenaMode`, `ArenaMatchupInfo`, `ArenaReveal`,
`ArenaSlotError`, `ArenaStreamEvent`, `ArenaStreamEventType`, `ArenaSseDecoder`,
`SlotState`, `RevealedModel`, `LeaderboardModel`, `LeaderboardComponents`,
`StyleControlReport`, `StyleEffect`, `GetSessionIdOptions`,
`SubmitArenaVoteInput`, `ArenaVoteTarget`, `UseArenaChatOptions`,
`UseArenaVoteOptions`, and `UseArenaLeaderboardOptions` are all exported —
enough to type your own parser against the wire.

The analytics contracts come with them: `AnalyticsResource`,
`AnalyticsModelRef`, `ArenaSummary`, `HeadToHeadPair`, `HeadToHeadStats`,
`ModelMetricsEntry`, `ActivityBucketSize`, `ActivityVoteBucket`,
`ActivityCumulativeBucket`, `ActivityStats`, `StyleCoefficient`,
`StyleControlStats`, `RatingHistoryPoint`, `RatingHistoryStats`,
`UseArenaAnalyticsOptions`, `UseArenaActivityOptions` and
`UseArenaRatingHistoryOptions`. They mirror the server's routes by convention —
the SDK has no compile-time dependency on the server.
