# Architecture

OmniArena is a small, self-hosted service for blind, multi-turn side-by-side LLM
comparisons. This document describes the architecture **as implemented today**
(Phase 1). The target end-state lives in [`pre-docs/architecture.md`](../../pre-docs/architecture.md)
and `artifacts/vision.md` (local-only, gitignored — not committed).

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
   ├─ provider adapters   Google / OpenAI / Ollama / vLLM / host proxy
   ├─ PiiScrubberPort     no-op placeholder before persistence
   └─ PostgresRepository conversations / turns / matchups / responses / preferences
              │
              ▼
        [ PostgreSQL ]      [ configured model endpoints ]
```

## Hexagonal boundaries (ports)

Even in the MVP, the core is separated from its edges by small interfaces in
`server/src/core/ports.ts`:

| Port | MVP implementation | Future replacement |
|---|---|---|
| `ModelProviderPort` | Google, OpenAI-compatible, Ollama, and host-proxy implementations | additional providers |
| `ProviderResolverPort` | `ProviderRegistry` (name → provider) | unchanged |
| `MatchmakingPort` | `RandomMatchmaker` | smart sampling / King-of-the-Hill |
| `PreferenceRepositoryPort` | `PostgresRepository` | unchanged |
| `LeaderboardPort` | win-rate SQL in `PostgresRepository` | Python Bradley-Terry worker |
| `PiiScrubberPort` | `NoopPiiScrubber` placeholder | real PII detection/redaction |

Tests inject in-memory implementations behind the same ports.

## Stream orchestration

`ArenaCore.stream()` (`server/src/core/arena.ts`) fires both provider calls
concurrently and merges their tokens into one async event stream via an
internal async queue. Internal events (`server/src/core/events.ts`):

- `token` — one token for slot `A` or `B`
- `slot_error` — a slot failed; the other slot keeps streaming (fault isolation)
- `slot_done` — full content + latency for one slot (internal only; the public
  variant strips content and metrics so identities can't be inferred)
- `matchup_done` — both slots finished

The chat route converts internal events to public SSE events with
`toPublicEvent()` and persists each `slot_done` as a `responses` row. Internal
completion events include TTFT, stream duration, token count/source, Markdown
density, and provider-reported model version. Each matchup stores the configured
`HARNESS_VERSION`.

## Multi-turn linear history

`matchup_started` returns a `conversationId` and zero-based `turnIndex`. A
follow-up sends that conversation ID; the repository reconstructs context from
stored prompts and decisive votes. Every prior assistant message is the
`left`/`right` winner only—client-provided history is never trusted.

The `turns.parent_response_id` and `(conversation_id, turn_index)` uniqueness
constraints prevent concurrent requests from branching the history. Ties,
both-bad votes, skips, and unvoted turns cannot be continued. Conversation
ownership is checked against the anonymous session ID.

## Provider and key-custody modes

- Direct: `GoogleModelProvider`, `OpenAICompatibleModelProvider`, and
  `OllamaModelProvider`. The OpenAI-compatible implementation is also
  registered as `vllm` when configured.
- Host custody: `HostProxyModelProvider` calls an OpenAI-compatible endpoint
  owned by the host. OmniArena receives only an optional proxy token, never the
  upstream provider credential.
- All providers receive the same typed `ChatMessage[]` and emit normalized
  token/metadata chunks.

Prompts and responses pass through `PiiScrubberPort` immediately before
persistence. Phase 1 intentionally wires a no-op implementation; it establishes
the security boundary but does not redact data yet.

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

Protocol adapters (Vercel AI SDK, AG-UI/A2UI, OpenAI SSE), WebSocket control
plane, Bradley-Terry rating worker, style-controlled fitting, smart
matchmaking, real PII redaction, and the published SDK package.
