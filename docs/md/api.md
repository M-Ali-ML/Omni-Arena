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
  "sessionId": "anon_123"
}
```

- `prompt` — required, 1–20,000 characters after trimming.
- `sessionId` — optional anonymous session identifier (1–200 characters).

Errors: `400` with `{ "error": "Invalid request", "details": ... }` on
validation failure.

Response: `200` with `content-type: text/event-stream`. Each event has an
`event:` name and a JSON `data:` payload that repeats the type:

| Event | Payload | Notes |
|---|---|---|
| `matchup_started` | `{ type, matchupId, matchupToken, slots: ["A", "B"] }` | First event. No model identities. |
| `token` | `{ type, slot, token }` | One token for slot `A` or `B`, interleaved. |
| `slot_error` | `{ type, slot, message }` | That slot failed; the other keeps streaming. |
| `slot_done` | `{ type, slot }` | Content and latency are stripped from the public event. |
| `matchup_done` | `{ type }` | Both slots finished; stream closes. |

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

Returns win/loss/tie counts and win rate per enabled model, ordered by wins.

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
      "winRate": 0.5217
    }
  ]
}
```

`winRate = wins / (wins + losses + ties)`; skips are excluded from the
denominator. Future rating fields (`rating`, `confidenceInterval`) will be
added alongside these, not instead of them.

## GET /health

Returns `{ "status": "ok" }`. Used by tooling and the dev proxy.
