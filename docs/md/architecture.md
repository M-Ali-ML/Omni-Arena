# Architecture

OmniArena is a small, self-hosted service for blind side-by-side LLM
comparisons. This document describes the architecture **as implemented today**
(the MVP). The target end-state lives in [`pre-docs/architecture.md`](../../pre-docs/architecture.md)
and [`pre-docs/vision.md`](../../pre-docs/vision.md).

Related: [API](api.md) · [Data model](data-model.md) · [Setup](setup.md)

## System overview

The repo is an npm workspace monorepo with two packages:

| Package | Path | Role |
|---|---|---|
| `@omni-arena/server` | `server/` | Fastify API: matchmaking, dual-model SSE streaming, voting, leaderboard |
| `@omni-arena/web` | `web/` | Vite + React demo UI with in-repo headless hooks |

```
[ web (React demo) ]
   │ useArenaChat / useArenaLeaderboard
   │ (Vite dev proxy → :3001)
   ▼
[ server (Fastify) ]
   ├─ routes/chat        POST /api/arena/chat   → multiplexed SSE
   ├─ routes/vote        POST /api/arena/vote   → reveal identities
   ├─ routes/leaderboard GET  /api/arena/leaderboard
   ├─ ArenaCore          fan-out to two providers, one event stream
   ├─ RandomMatchmaker   picks + blind-randomizes a model pair
   ├─ MatchupTokenService HMAC-signed matchup tokens
   └─ PostgresRepository models / matchups / responses / preferences
              │
              ▼
        [ PostgreSQL ]      [ Google Gemini API ]
```

## Hexagonal boundaries (ports)

Even in the MVP, the core is separated from its edges by small interfaces in
`server/src/core/ports.ts`:

| Port | MVP implementation | Future replacement |
|---|---|---|
| `ModelProviderPort` | `GoogleModelProvider` (Gemini streaming) | OpenAI, Ollama/vLLM, host-proxy mode |
| `ProviderResolverPort` | `ProviderRegistry` (name → provider) | unchanged |
| `MatchmakingPort` | `RandomMatchmaker` | smart sampling / King-of-the-Hill |
| `PreferenceRepositoryPort` | `PostgresRepository` | unchanged |
| `LeaderboardPort` | win-rate SQL in `PostgresRepository` | Python Bradley-Terry worker |

Tests inject in-memory implementations behind the same ports.

## Stream orchestration

`ArenaCore.stream()` (`server/src/core/arena.ts`) fires both provider calls
concurrently and merges their tokens into one async event stream via an
internal async queue. Internal events (`server/src/core/events.ts`):

- `token` — one token for slot `A` or `B`
- `slot_error` — a slot failed; the other slot keeps streaming (fault isolation)
- `slot_done` — full content + latency for one slot (internal only; the public
  variant strips content and latency so identities can't be inferred)
- `matchup_done` — both slots finished

The chat route converts internal events to public SSE events with
`toPublicEvent()` and persists each `slot_done` as a `responses` row.

## Blind voting integrity

- Model identities are never sent before a vote. `matchup_started` carries only
  slot IDs and a matchup token.
- The matchup token is HMAC-SHA256 signed (`server/src/token.ts`), contains
  `matchupId`, both slot model IDs, an optional session ID, and a 15-minute
  expiry. Only its SHA-256 hash is stored in the database.
- Voting verifies signature, expiry, claims-vs-database consistency, and the
  stored hash; a unique constraint enforces one vote per matchup.

## Frontend

`web/src/useArenaChat.ts` is a headless React hook: it POSTs the prompt,
parses the multiplexed SSE stream into per-slot state, submits votes with the
matchup token, and exposes revealed identities only after a successful vote.
`web/src/useArenaLeaderboard.ts` fetches the leaderboard. `App.tsx` is a
single-page demo (prompt box, two anonymous panes with markdown rendering,
five vote buttons, reveal, leaderboard).

## What is intentionally not built yet

Per the MVP scope: protocol adapters (Vercel AI SDK, AG-UI/A2UI, OpenAI SSE),
WebSocket control plane, Bradley-Terry rating worker, style control,
multi-turn history, smart matchmaking, PII scrubbing, published SDK package.
