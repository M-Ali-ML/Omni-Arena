---
name: OmniArena MVP build
overview: "Build the thin vertical slice from pre-docs/mvp.md: a TypeScript backend with blind two-model SSE streaming, votes, and a win-rate leaderboard on Postgres, plus a tiny React demo UI with an in-repo useArenaChat hook."
todos:
  - id: scaffold
    content: "Scaffold repo: server + web workspaces, docker-compose for Postgres, root README updates"
    status: completed
  - id: core
    content: Define internal event types and ports; implement arena fan-out/multiplexing core
    status: completed
  - id: providers
    content: Implement MockModelProvider and OpenAICompatibleProvider
    status: completed
  - id: db
    content: Postgres schema, migration and seed scripts, repository + leaderboard implementations
    status: completed
  - id: api
    content: Chat SSE endpoint with random matchmaking + HMAC matchup tokens
    status: completed
  - id: vote-leaderboard
    content: Vote endpoint with token verification, single-vote constraint, identity reveal; leaderboard endpoint
    status: completed
  - id: web
    content: "React demo: useArenaChat hook, A/B panes, vote buttons, reveal, leaderboard view"
    status: completed
  - id: tests
    content: Vitest tests for multiplexing, vote validation, identity masking
    status: completed
  - id: verify
    content: Run full loop end-to-end against local Postgres and fix issues
    status: completed
isProject: false
---

# OmniArena MVP

Implement the vertical slice from [pre-docs/mvp.md](pre-docs/mvp.md): prompt in, two blind streamed responses over one SSE connection, vote, identity reveal, win-rate leaderboard.

## Stack choices (simplest that fits the doc)

- **Backend**: Node + TypeScript + Fastify (good SSE ergonomics), raw SQL via `pg` (no ORM), `vitest` for tests.
- **DB**: Postgres via `docker-compose.yml`; one idempotent migration script creates the 4 tables.
- **Frontend**: Vite + React demo app; `useArenaChat` lives in the app (not a package). SSE parsed from a `fetch` body stream (EventSource can't POST).
- **Providers**: `MockModelProvider` is the default so everything runs with zero API keys; `OpenAICompatibleProvider` enabled via env (`OPENAI_BASE_URL`, `OPENAI_API_KEY`).

## Repo layout

```text
server/
  src/core/events.ts        # internal arena event types (token, slot_error, slot_done, ...)
  src/core/ports.ts         # ModelProviderPort, MatchmakingPort, PreferenceRepositoryPort, LeaderboardPort
  src/core/arena.ts         # fan-out + multiplexing of two provider streams into one event stream
  src/providers/mock.ts     # deterministic token stream, configurable delay/failure
  src/providers/openai-compatible.ts
  src/matchmaking/random.ts # random distinct pair + random slot assignment
  src/token.ts              # HMAC matchup token (matchup_id, slot model ids, expiry); hash stored in DB
  src/db/{pool,migrate,seed}.ts + schema.sql
  src/repo/postgres.ts      # PreferenceRepository + Leaderboard impls
  src/routes/{chat,vote,leaderboard}.ts
  src/server.ts
web/
  src/useArenaChat.ts       # sendPrompt, vote, slots, isStreaming, revealedModels, error
  src/App.tsx               # prompt box, A/B panes, vote buttons, reveal, leaderboard
docker-compose.yml          # postgres:16
```

## Behavior contract (from the doc)

- `POST /api/arena/chat` → SSE: `matchup_started` (matchup id, public slots, signed vote token — **no model names**), interleaved `token` events tagged `{slot: "A"|"B"}`, `slot_error` / `slot_done` per slot, `matchup_done`. One slot failing never kills the other.
- `POST /api/arena/vote` → verifies HMAC token + expiry, inserts preference (`left|right|both_good|both_bad|skip`), unique constraint on `matchup_id` enforces one vote, then returns model identities.
- `GET /api/arena/leaderboard` → wins/losses/ties/winRate per model, `score = wins / non_skip_votes`.
- Schema exactly per doc: `models`, `matchups` (with `slot_*_model_id` + `matchup_token_hash`), `responses` (content, latency_ms, error), `preferences`.

## Tests (vitest)

- Stream multiplexing: two mock streams interleave; one erroring slot doesn't stop the other.
- Vote validation: bad/expired/reused token rejected; identities revealed only on accepted vote.
- Identity masking: `matchup_started` payload contains no model names.

## Verification

Run `docker compose up -d`, migrate + seed 3 mock models, start server and web, then exercise the loop end-to-end (prompt → dual streams → vote → reveal → leaderboard changes) and run the test suite.