# API

Base URL: `http://localhost:3001`. All bodies are JSON. The web dev server
proxies `/api` and `/health` to the API.

Related: [Architecture](architecture.md) · [Integration](integration.md) · [Rating methodology](rating-methodology.md) · [Data model](data-model.md) · [Setup](setup.md) · [SDK](sdk.md)

## POST /api/arena/chat

Starts a blind matchup and streams both responses over one SSE connection.

Request:

```json
{
  "prompt": "Explain JWTs in simple terms",
  "sessionId": "anon_123",
  "conversationId": "optional UUID from an earlier matchup_started event"
}
```

- `prompt` — required, 1–20,000 characters after trimming.
- `sessionId` — optional anonymous session identifier (1–200 characters).
- `conversationId` — optional. Omit it to start a conversation. Supply the
  previous value after a decisive `left`/`right` vote to continue from that
  winning response.

The server loads prior prompts and only the winning response for each completed
turn. Client-provided message history is never accepted. A tie, both-bad, skip,
or unvoted matchup has no single winning response and cannot be continued.

Response: `200` with `content-type: text/event-stream`. Each event has an
`event:` name and a JSON `data:` payload that repeats the type:

| Event | Payload | Notes |
|---|---|---|
| `matchup_started` | `{ type, matchupId, matchupToken, conversationId, turnIndex, slots: ["A", "B"] }` | First event. No model identities. Save `conversationId` for a follow-up. |
| `token` | `{ type, slot, token }` | One token for slot `A` or `B`, interleaved. |
| `slot_error` | `{ type, slot, message }` | That slot failed; the other keeps streaming. |
| `slot_done` | `{ type, slot }` | Content and latency are stripped from the public event. |
| `matchup_done` | `{ type }` | Both slots finished; stream closes. |

Errors before streaming:

| Status | Meaning |
|---|---|
| `400` | Invalid request body |
| `403` | `sessionId` does not own the requested conversation |
| `404` | Unknown `conversationId` |
| `409` | The prior turn has no decisive vote, or another request already advanced the conversation |

### Protocol selection

The same matchup stream can be framed in five wire protocols. Selection precedence:

1. `?protocol=` query parameter (case-insensitive alias).
2. The request `Accept` header media type.
3. Default: **native SSE**.

An unknown `?protocol=` value falls back to native SSE, so a bad value never
breaks the default path. Native SSE is byte-for-byte unchanged, so existing
clients (including the demo and the SDK) are unaffected — the table above still
describes the default stream.

| Protocol | `?protocol=` aliases | `Accept` media type(s) | Response `content-type` |
|---|---|---|---|
| Native SSE *(default)* | `sse`, `native`, `native-sse` | `text/event-stream` | `text/event-stream` |
| AG-UI | `agui`, `ag-ui` | `application/vnd.ag-ui+json` | `text/event-stream` |
| A2UI | `a2ui` | `application/vnd.a2ui+json`, `application/x-ndjson` | `application/x-ndjson` |
| Vercel AI SDK | `vercel`, `vercel-ai`, `ai-sdk` | `application/vnd.vercel.ai.ui-message-stream+json` | `text/event-stream` (+ `x-vercel-ai-ui-message-stream: v1`) |
| OpenAI SSE | `openai`, `openai-sse` | `application/vnd.openai.chat-chunk+json` | `text/event-stream` |

The **internal event semantics are identical across protocols** — the same
`matchup_started` / `token` / `slot_error` / `slot_done` / `matchup_done`
sequence over the same two slots (A, B). Only the framing differs, and every
frame is schema-validated at the transport boundary before it is written.

Per-protocol framing, at a conceptual level:

- **Native SSE** (default, unchanged): `event:`/`data:` pairs, one per event;
  no trailing sentinel. This is the event table above.
- **AG-UI**: typed AG-UI events, one `data:` line each, over SSE. `matchup_started`
  → `RUN_STARTED` plus one `TEXT_MESSAGE_START` per slot (role `assistant`,
  tagged `slot` A/B); `token` → `TEXT_MESSAGE_CONTENT` (`delta`, `slot`);
  `slot_error` → `CUSTOM` named `slot_error` (`{ slot, message }`, so the
  surviving slot keeps streaming); `slot_done` → `TEXT_MESSAGE_END`;
  `matchup_done` → `RUN_FINISHED`. `runId` is the matchup ID, `threadId` the
  conversation ID.
- **A2UI**: schema-validated **NDJSON** (`application/x-ndjson`) — one flat,
  self-describing JSON object per line, versioned `a2ui/1`, painting two
  surfaces A/B. `surface_init` (`matchupId`, `conversationId`, `turnIndex`,
  `surfaces`) → `text_append` (`surface`, `text`) → `error` (`surface`,
  `message`) → `surface_done` (`surface`) → `session_done`.
- **Vercel AI SDK**: the AI SDK **UI Message Stream** (header
  `x-vercel-ai-ui-message-stream: v1`) over SSE. Slot A rides the primary text
  channel (`start` → `data-arena-meta` → `text-start` → `text-delta` →
  `text-end`); slot B is multiplexed through custom data parts
  (`data-arena-b-delta` / `data-arena-b-done`); a single-slot failure is a
  `data-arena-error` part; the run ends with `finish` and a trailing
  `data: [DONE]` sentinel.
- **OpenAI SSE**: `chat.completion.chunk` frames so an OpenAI-style client can
  drive the arena. The two slots map onto two `choices` entries (slot A →
  index 0, slot B → index 1) of one dual-stream completion: `role: "assistant"`
  on start, `content` deltas per token, `finish_reason: "stop"` on `slot_done`.
  A single-slot error is surfaced inline as `content` on that choice while the
  other keeps streaming. Ends with a trailing `data: [DONE]` sentinel.

The [`@omni-arena/react`](sdk.md) SDK and the demo app consume the default
native SSE stream. For a per-protocol walkthrough — concrete wire examples, how
Model A vs B is carried, how to vote, which stacks each suits, and the two
shipped example apps — see the [integration guide](integration.md).

**Vote-token availability differs by protocol.** Native SSE, A2UI, and the
Vercel AI SDK adapter put the `matchupToken` on the wire (native SSE in
`matchup_started`, Vercel in `data-arena-meta`, A2UI carries only the
`matchupId`), so those paths can vote directly. The **AG-UI and OpenAI SSE
adapters do not expose the vote token** — voting over them requires obtaining the
token from another channel. See the [integration guide](integration.md).

## GET /api/arena/control (WebSocket)

The **control plane**: a bidirectional WebSocket that acts on an in-flight
matchup out-of-band from the token stream. Connect a WebSocket to
`/api/arena/control`; messages are JSON in both directions.

**`stop`** — abort an in-flight matchup:

```json
{ "type": "stop", "matchupId": "<uuid>" }
```

Aborts the matchup's stream via the matchup registry's `AbortController`
(the `AbortSignal` is threaded through `ArenaCore.stream`). Reply:

```json
{ "type": "stopped", "matchupId": "<uuid>", "ok": true }
```

`ok` is `false` when the matchup is unknown — never started, already finished,
or already stopped.

**`steer`** — mid-stream steering (**stubbed extension point**):

```json
{ "type": "steer", "matchupId": "<uuid>", "instruction": "be more concise" }
```

The message is schema-validated (`instruction` must be non-empty) and
documented, but steering is **not yet wired into the core**. It always returns a
negative acknowledgement so the wire contract and seam exist ahead of the
implementation:

```json
{ "type": "steer_ack", "matchupId": "<uuid>", "accepted": false, "reason": "…" }
```

Errors: invalid JSON returns `{ "type": "error", "message": "Invalid JSON control message" }`;
an unknown or malformed message (including a `matchupId` that is not a UUID)
returns `{ "type": "error", "message": "Unknown or malformed control message" }`.

## POST /api/arena/vote

Records one vote and reveals model identities.

Request:

```json
{
  "matchupId": "3f6e...",
  "matchupToken": "eyJt....sig",
  "vote": "left"
}
```

`vote` is one of `left`, `right`, `both_good`, `both_bad`, `skip`.

Success response:

```json
{
  "accepted": true,
  "models": {
    "A": { "id": "…", "displayName": "Gemini 3.5 Flash" },
    "B": { "id": "…", "displayName": "Gemini 3 Flash" }
  }
}
```

Errors:

| Status | Meaning |
|---|---|
| `400` | Invalid body |
| `401` | Bad signature, expired token, or claims that don't match the stored matchup |
| `404` | Unknown `matchupId` |
| `409` | A vote was already recorded for this matchup |

## GET /api/arena/leaderboard

Returns win/loss/tie counts, win rate, and (when the rating worker has run)
Bradley-Terry ratings per enabled model. Ordered by `rating` (nulls last),
then wins.

```json
{
  "models": [
    {
      "id": "…",
      "displayName": "Gemini 3.5 Flash",
      "wins": 12,
      "losses": 8,
      "ties": 3,
      "skips": 1,
      "totalVotes": 24,
      "winRate": 0.5217,
      "rating": 1184.3,
      "ratingStdError": 41.7,
      "confidenceInterval": { "lower": 1102.6, "upper": 1266.0 },
      "componentId": 0,
      "styleControlledRating": 1147.9,
      "styleControlledStdError": 44.2,
      "styleControlledConfidenceInterval": { "lower": 1061.3, "upper": 1234.5 }
    }
  ]
}
```

`winRate = wins / (wins + losses + ties)`; skips are excluded from the
denominator. The win-rate fields are always present.

The rating fields are populated by the Python rating worker (`worker/`):

| Field | Meaning |
|---|---|
| `rating` | Bradley-Terry rating on an Elo-like scale (`1000 + (400/ln10)·r`) |
| `ratingStdError` | Standard error of the rating (same scale) |
| `confidenceInterval` | 95% CI `{ lower, upper }` from Fisher information |
| `componentId` | Connected-component id; ratings only comparable within a component |
| `styleControlledRating` | Bradley-Terry rating with verbosity/formatting/latency/position confounders regressed out jointly, from the worker's heavier style pass |
| `styleControlledStdError` | Standard error of the style-controlled rating (same scale) |
| `styleControlledConfidenceInterval` | 95% CI `{ lower, upper }` for the style-controlled rating |

The `rating*`/`componentId` fields are `null` until the default worker pass has
rated the model; the `styleControlled*` fields are `null` until the heavier
style pass has run. Clients must treat all of them as optional and keep using
`winRate` as a fallback. See the [rating methodology](rating-methodology.md) for
how these numbers are computed.

## GET /health

Returns `{ "status": "ok" }`. Used by tooling and the dev proxy.
