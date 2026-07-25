# SDK

`@omni-arena/react` is the **headless** React SDK for OmniArena: blind
side-by-side LLM comparisons over one SSE stream, blind voting with identity
reveal, multi-turn continuation from the winning response, and the
Bradley-Terry leaderboard. No UI, no styling — just state and actions. Bring
your own components.

The SDK lives in the `packages/react-sdk/` workspace (package name
`@omni-arena/react`) and is the single source of truth for the arena hooks; the
demo app in `web/` is its reference consumer. It is not published to npm yet.

It ships in two layers, and which one you want depends on who owns the
conversation state:

- **Primitives** — stateless, React-free functions and types (session id,
  vote call, SSE decoding, wire types). Use these when an existing chat app
  (Vercel AI Chatbot's `useChat`, assistant-ui's runtime, CopilotKit, your own)
  already owns the connection, the stream, and the message store that gets
  persisted and replayed. They add arena semantics without competing for that
  state, and they run in a server route as happily as in the browser.
- **`useArenaChat`** — the all-in-one hook for a greenfield app with no chat
  runtime of its own. It is built *on* the primitives, so there is one
  implementation of each piece.

Related: [Architecture](architecture.md) · [API](api.md) · [Integration](integration.md) · [Rating methodology](rating-methodology.md) · [Data model](data-model.md) · [Setup](setup.md)

## Install

From another package in this monorepo, depend on it the same way `web/` does:

```json
{
  "dependencies": {
    "@omni-arena/react": "*"
  }
}
```

`react` (>=18) is a peer dependency. Once the package is published to npm, the
public install will be `npm install @omni-arena/react react`.

## Exports

```ts
import {
  // primitives — no React, no state
  getSessionId,
  submitArenaVote,
  createArenaSseDecoder,
  readArenaStream,
  parseArenaMatchup,
  parseArenaReveal,
  parseArenaSlotError,
  isDecisiveVote,
  isArenaSlot,
  isArenaVote,
  ARENA_VOTE_VALUES,
  ARENA_SESSION_STORAGE_KEY,
  // hooks
  useArenaVote,
  useArenaChat,
  useArenaLeaderboard,
  // analytics hooks (one per /api/arena/analytics/* endpoint)
  useArenaSummary,
  useArenaHeadToHead,
  useArenaModelMetrics,
  useArenaActivity,
  useArenaStyleControl,
  useArenaRatingHistory,
  type ArenaSlot,
  type ArenaVote,
  type ArenaMode,
  type ArenaMatchupInfo,
  type ArenaReveal,
  type ArenaSlotError,
  type ArenaStreamEvent,
  type ArenaStreamEventType,
  type ArenaSseDecoder,
  type SlotState,
  type RevealedModel,
  type GetSessionIdOptions,
  type SubmitArenaVoteInput,
  type UseArenaVoteOptions,
  type ArenaVoteTarget,
  type LeaderboardModel,
  type LeaderboardComponents,
  type StyleControlReport,
  type StyleEffect,
  type UseArenaChatOptions,
  type UseArenaLeaderboardOptions,
  // analytics payload and option types
  type AnalyticsResource,
  type AnalyticsModelRef,
  type ArenaSummary,
  type HeadToHeadStats,
  type HeadToHeadPair,
  type ModelMetricsEntry,
  type ActivityStats,
  type ActivityBucketSize,
  type ActivityVoteBucket,
  type ActivityCumulativeBucket,
  type StyleControlStats,
  type StyleCoefficient,
  type RatingHistoryStats,
  type RatingHistoryPoint,
  type UseArenaAnalyticsOptions,
  type UseArenaActivityOptions,
  type UseArenaRatingHistoryOptions,
} from "@omni-arena/react";
```

The primitives, three arena hooks, six analytics hooks, and their public types —
`packages/react-sdk/src/index.ts` is the complete public surface, and nothing
outside it is importable (`exports` in `package.json` exposes only the package
root). `ArenaSlot` is `"A" | "B"`; `ArenaVote` is
`"left" | "right" | "both_good" | "both_bad" | "skip"`.

## Primitives (host-app integration)

Every primitive is stateless and free of React and DOM assumptions, so it can be
called from a Next.js route handler, an edge function, or a non-React client.

| Export | Signature | Purpose |
|---|---|---|
| `getSessionId(options?)` | `(GetSessionIdOptions) => string` | The anonymous session id the arena ties conversation ownership to. Persisted in `localStorage` under `ARENA_SESSION_STORAGE_KEY` (`omni-arena-session`); pass `{ storage, key, prefix }` to relocate it, or call it where there is no storage (a server route) to mint a one-off id. |
| `submitArenaVote(input)` | `(SubmitArenaVoteInput) => Promise<ArenaReveal>` | `POST /api/arena/vote`. Rejects with the server's own message (`Vote already recorded`, `Invalid matchup token`, …); resolves with the reveal. Takes `baseUrl` and an optional `signal`, so a host's proxy route can forward its own vote. |
| `useArenaVote(options?)` | see below | A vote button's worth of state around `submitArenaVote`, for apps whose runtime owns the messages and only needs the reveal. |
| `createArenaSseDecoder<T>()` | `() => ArenaSseDecoder<T>` | Incremental SSE decoder: `push(chunk)` returns the events a chunk completed, `flush()` the trailing one. Handles CRLF, multi-line `data:`, chunk-split multi-byte characters, and a `data: [DONE]` sentinel. Generic over the payload because the adapters reframe the same round. |
| `readArenaStream<T>(source)` | `(Response \| ReadableStream) => AsyncGenerator<T>` | The same decoder as an `for await` iterator, for a consumer that made the request itself. |
| `parseArenaMatchup(value)` | `(unknown) => ArenaMatchupInfo \| null` | Normalise a round from a `matchup_started` event, AG-UI's `arena_matchup` custom value, or a `data-arena-meta` part — all carry the same fields. |
| `parseArenaReveal(value)` | `(unknown) => ArenaReveal \| null` | Read a reveal from a vote response or an adapter's reveal part. Null on a half-reveal, so a UI cannot show one identity while still claiming the round is blind. |
| `parseArenaSlotError(value)` | `(unknown) => ArenaSlotError \| null` | Read a per-slot failure; defaults the message. |
| `isDecisiveVote(vote)` | `(ArenaVote) => boolean` | Whether the vote leaves a winning response, i.e. whether the next turn may pass `conversationId`. Only `left`/`right` do. |
| `isArenaSlot` / `isArenaVote` / `ARENA_VOTE_VALUES` | — | Guards and the five vote values, for validating untyped payloads at a host boundary. |

`ArenaMatchupInfo` is the normalised round:

```ts
{
  matchupId: string;          // always present; the control-plane stream id
  matchupToken: string | null; // null on a round with nothing to vote on
  conversationId?: string;    // omitted when the server persisted nothing
  turnIndex?: number;         // omitted with conversationId
  slots: ArenaSlot[];         // defaults to ["A", "B"]
  mode: ArenaMode;            // defaults to "matchup"
  votable: boolean;           // authoritative; defaults to true for older servers
}
```

`matchupToken`, `conversationId`, and `turnIndex` are optional on the wire and
omitted entirely for a `single` (non-votable) round, so the parser normalises an
empty-string token to `null` and leaves the two conversation fields off the
result rather than inventing defaults — a host that sends a fabricated
`conversationId` back gets a 404.

A reveal is `{ models: Record<ArenaSlot, RevealedModel>, vote: ArenaVote | null }`
— the two identities plus the vote they were granted for, so a UI can badge the
winning column without tracking the choice itself. `RevealedModel` is
`{ id, displayName }`. `parseArenaReveal()` sets `vote` to `null` when the
payload did not carry one; `submitArenaVote()` always fills it in, because it
knows the vote it sent.

`useArenaVote(options?)` takes `{ baseUrl?, matchupId?, matchupToken? }` and
returns `{ vote, reset, reveal, isVoting, error, canVote }`. `vote(choice,
target?)` resolves to the `ArenaReveal` or to `null` with the message in `error`
— it never throws, so a click handler needs no `try`/`catch` — and `target`
overrides the round for a host that keeps several rounds on screen. `canVote` is
`true` only while there is a `matchupId` *and* a non-null `matchupToken` *and*
no reveal yet, so one round cannot be voted on twice; `reset()` clears the
reveal, the error, and the in-flight flag.

A host app that owns its own stream typically needs three of these: `getSessionId()`
when it starts a round, `parseArenaMatchup()` on the round's metadata, and
`submitArenaVote()`/`useArenaVote()` when the user votes.

```ts
// A host's own proxy route: forward the vote, keep the reveal server-side.
import { submitArenaVote } from "@omni-arena/react";

export async function POST(request: Request) {
  const { matchupId, matchupToken, vote } = await request.json();
  const reveal = await submitArenaVote({
    matchupId,
    matchupToken,
    vote,
    baseUrl: process.env.OMNIARENA_URL,
  });
  return Response.json(reveal);
}
```

## `useArenaChat(options?)`

Starts and continues matchups, streams both responses into per-slot state, and
records votes.

Returns:

| Field | Type | Description |
|---|---|---|
| `sendPrompt(prompt)` | `(string) => Promise<void>` | Start or continue a matchup; streams tokens into `slots`. |
| `vote(vote)` | `(ArenaVote) => Promise<void>` | Record a vote and reveal identities. |
| `stop()` | `() => Promise<void>` | Abort the in-flight matchup over the [`/api/arena/control`](api.md) WebSocket, then settle both slots locally. No-op when nothing is streaming; failures land in `error` rather than throwing. |
| `resetConversation()` | `() => void` | Abort any stream and clear all state. |
| `slots` | `Record<ArenaSlot, SlotState>` | Per-slot `content`, `status` (`idle`/`streaming`/`done`/`error`), and `error`. |
| `isStreaming` | `boolean` | A matchup is currently streaming. |
| `canVote` | `boolean` | A matchup is ready to be voted on. |
| `revealedModels` | `Record<ArenaSlot, RevealedModel> \| undefined` | Model identities, available only after voting. |
| `conversationId` | `string \| undefined` | The active multi-turn conversation, if any. |
| `error` | `string \| null` | Last request error, including a terminal `run_error` the server reported mid-stream. |

The hook is a composition of the primitives above — `getSessionId()` for the
session, `createArenaSseDecoder()` for the stream, `parseArenaMatchup()` for the
round, `submitArenaVote()` for the vote — plus the React state and the control
socket. It continues a conversation only after a decisive `left`/`right` vote
(matching the server's linear-history rules — see [API](api.md)).

A round the server persisted nothing for (a `single` one) arrives with no
`conversationId` and no vote token, and the hook holds none: `canVote` stays
`false` and the next prompt starts fresh rather than sending back an id the server
would reject.

The control socket is opened lazily on the first `stop()` and closed on the
`stopped` acknowledgement, on `resetConversation()`, or on unmount, so a hook
that never stops a matchup never opens a WebSocket.

## `useArenaLeaderboard(options?)`

Fetches standings once on mount and exposes a `refresh()` to call after a vote.

Returns:

| Field | Type | Description |
|---|---|---|
| `models` | `LeaderboardModel[]` | Win/loss/tie/skip counts, `winRate`, and the optional worker-computed `rating*` and `styleControlled*` fields. |
| `components` | `LeaderboardComponents` | Connectivity of the comparison graph: `count` (`null` before the worker has run) and `groups`. Ratings are only comparable within one component, so a UI showing them should surface this. |
| `styleControl` | `StyleControlReport` | The fitted style confounders (`effects`, each with `logOdds`, `points`, `basis`, `perUnit`), plus `votesObserved` and `computedAt`. |
| `refresh()` | `() => Promise<void>` | Re-fetch; call after a vote. |
| `error` | `string \| null` | Last request error. |

Both context fields are read as optional on the wire and fall back to an empty
report (`count: null`, `effects: []`), so the hook keeps working against a server
that predates them. See [API → leaderboard](api.md) for the field-by-field
meaning.

## Analytics hooks

One hook per [`/api/arena/analytics/*` endpoint](api.md), powering the demo's
insights dashboard. Each fetches once on mount and returns the same shape,
exported as `AnalyticsResource<T>`:

```ts
{ data: T | null; refresh(): Promise<void>; error: string | null }
```

Endpoints below are relative to `/api/arena` (the hooks prepend `baseUrl` and
that prefix themselves).

| Hook | Endpoint | `data` type | Extra options |
|---|---|---|---|
| `useArenaSummary()` | `/analytics/summary` | `ArenaSummary` | — |
| `useArenaHeadToHead()` | `/analytics/head-to-head` | `HeadToHeadStats` | — |
| `useArenaModelMetrics()` | `/analytics/model-metrics` | `{ models: ModelMetricsEntry[] }` | — |
| `useArenaActivity()` | `/analytics/activity` | `ActivityStats` | `bucket: "day" \| "hour"` (default `day`) |
| `useArenaStyleControl()` | `/analytics/style-control` | `StyleControlStats` | — |
| `useArenaRatingHistory()` | `/analytics/rating-history` | `RatingHistoryStats` | `since: string` (ISO 8601) |

`data` is `null` until the first response arrives; every payload type is exported
and mirrors the API contract. Note that `useArenaModelMetrics()` is the one hook
whose payload is a wrapper object rather than the named type — the endpoint
answers `{ models: [...] }`, so read `data.models`. All take the same `baseUrl`
option as the arena hooks; `useArenaActivity` and `useArenaRatingHistory` extend
it with the extra option above (`UseArenaActivityOptions`,
`UseArenaRatingHistoryOptions`).

## The `baseUrl` option

Every hook — and `submitArenaVote()` — takes `baseUrl?: string`: the origin (or path prefix) the
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

The demo app (`web/`) is the reference consumer: `web/src/routes/ArenaPage.tsx`
wires `useArenaChat` and `useArenaLeaderboard` into a prompt box, two anonymous
markdown panes, five vote buttons, the identity reveal, and the leaderboard,
while the `/insights` dashboard (`web/src/routes/InsightsPage.tsx` plus
`web/src/dashboard/`) consumes `useArenaSummary`, `useArenaHeadToHead`,
`useArenaModelMetrics`, `useArenaActivity`, and `useArenaRatingHistory`. Its
style-bias tab reads the confounders off `useArenaLeaderboard`'s `styleControl`
field instead of the dedicated `useArenaStyleControl` hook, so that hook has no
demo consumer — a host app that wants the style fit without the standings is its
intended caller.
