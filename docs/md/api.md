# API

Base URL: `http://localhost:3001`. All bodies are JSON. The web dev server
proxies `/api` and `/health` to the API.

Related: [Architecture](architecture.md) · [Data model](data-model.md) · [Setup](setup.md)

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
      "componentId": 0
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

All four are `null` until the worker has rated the model, so clients must treat
them as optional and keep using `winRate` as a fallback.

## GET /health

Returns `{ "status": "ok" }`. Used by tooling and the dev proxy.
