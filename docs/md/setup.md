# Setup

Requirements: Node.js 20+, npm, Docker. Python 3.10+ for the rating worker.

Related: [Architecture](architecture.md) · [API](api.md) · [Data model](data-model.md) · [SDK](sdk.md)

## Quick start

```bash
cp .env.example .env      # configure the provider used by the seed lineup
npm install
docker compose up -d      # Postgres 16
npm run db:migrate --workspace server
npm run db:seed --workspace server
npm run dev               # server on :3001, web on :5173
```

Open http://localhost:5173.

## Workspaces

The repo is an npm workspace monorepo. The root `workspaces` array lists them in
build order — `server`, `packages/react-sdk`, then `web` — so `npm run build`
compiles the SDK **before** the demo that depends on it:

| Workspace | Path | Notes |
|---|---|---|
| `@omni-arena/server` | `server/` | Fastify API. New dependency `@fastify/websocket` powers the `/api/arena/control` WebSocket control plane. |
| `@omni-arena/react` | `packages/react-sdk/` | Published headless React SDK (`useArenaChat`, `useArenaLeaderboard`). The demo consumes it. See [SDK](sdk.md). |
| `@omni-arena/web` | `web/` | Vite + React demo; imports `@omni-arena/react` (workspace `*`). |
| `omniarena-rating` | `worker/` | Python rating worker (not an npm workspace). |

## Environment variables

Loaded from the repo-root `.env` regardless of workspace working directory
(`server/src/env.ts`).

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GOOGLE_API_KEY` | for `google` models | — | Gemini API key ([create one](https://aistudio.google.com/apikey)) |
| `OPENAI_API_KEY` | for OpenAI | — | Bearer token for the OpenAI-compatible provider |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` when a key is set | Alternate OpenAI-compatible base URL |
| `OLLAMA_BASE_URL` | no | `http://localhost:11434` | Ollama server; the `ollama` provider is always registered |
| `VLLM_BASE_URL` | for `vllm` models | — | vLLM OpenAI-compatible base URL |
| `VLLM_API_KEY` | no | — | Optional bearer token for vLLM |
| `HOST_PROXY_URL` | for `host-proxy` models | — | Host-owned OpenAI-compatible base URL |
| `HOST_PROXY_TOKEN` | no | — | Optional bearer token used only to authenticate to the host proxy |
| `HARNESS_VERSION` | no | `v1` | Version label persisted on every matchup |
| `REFIT_INTERVAL_SECONDS` | no | `300` | Rating worker loop interval between refits |
| `RATING_RIDGE` | no | `0.01` | Rating worker ridge-prior strength (log-odds scale) |
| `STYLE_RIDGE` | no | `0.05` | Ridge-prior strength for the style-controlled fit |
| `MATCHMAKER` | no | `smart` | Matchmaking strategy: `smart` (under-sampled / high-variance pairs) or `random` (uniform) |
| `DATABASE_URL` | yes | — | Postgres connection string; docker-compose default is `postgres://omni_arena:omni_arena@localhost:5432/omni_arena` |
| `MATCHUP_TOKEN_SECRET` | production | insecure dev default | HMAC secret for matchup tokens, minimum 16 characters |
| `PORT` | no | `3001` | API port |
| `WEB_ORIGIN` | no | `http://localhost:5173` | Allowed CORS origin |

The default seed lineup contains Google models, so the unmodified seed still
needs `GOOGLE_API_KEY`. To use OpenAI, Ollama, vLLM, or host-proxy models, set
their `provider` and `provider_model_id` entries in `server/src/db/seed.ts` and
re-run the seed.

The host-proxy endpoint must expose OpenAI-compatible streaming chat
completions at `<HOST_PROXY_URL>/chat/completions`. OmniArena sends
`model`, the full linear `messages` array, `stream: true`, and the
`x-omni-arena-proxy: 1` header. The host keeps the upstream provider key.

## Database

- **Migrate:** `npm run db:migrate --workspace server` — applies unapplied SQL
  files from `server/src/db/migrations/` in filename order, each in a
  transaction, tracked in `schema_migrations`. To add a migration, create the
  next `NNN_description.sql` file; never edit an applied migration.
- **Seed:** `npm run db:seed --workspace server` — upserts the model lineup by
  `(provider, provider_model_id)`. Edit `server/src/db/seed.ts` to change the
  arena lineup, then re-run.

## Rating worker

The Bradley-Terry rating worker lives in `worker/` (Python, NumPy/SciPy). It
screens anomalous voting sessions, aggregates votes in-database, fits ratings
with Fisher-information confidence intervals, and upserts the `model_ratings`
table the leaderboard reads. The optional `--style` flag additionally runs the
heavier style-controlled pass into `model_style_ratings`.

```bash
cd worker
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# One-shot (requires migrations applied and DATABASE_URL set):
DATABASE_URL=postgres://omni_arena:omni_arena@localhost:5432/omni_arena \
  python -m omniarena_rating

# Also run the heavier style-controlled pass on raw votes:
python -m omniarena_rating --style

# Periodic loop with warm-started refits (add --style for the style pass):
python -m omniarena_rating --loop --interval 300 --ridge 0.01

# Skip the pre-fit anomaly screen (keep every session):
python -m omniarena_rating --no-anomaly-filter

# Tests (pure Python, no database):
python -m pytest
```

The pre-fit anomaly screen (`--no-anomaly-filter` to disable) drops spam or
malicious voting sessions via p-value tests before any fit runs.

`docker compose up -d` also starts a `worker` service that runs the loop
against the `postgres` service automatically. Ratings appear on the leaderboard
after the first successful refit; until then the rating fields are null.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Server (`tsx watch`) and web (Vite) concurrently |
| `npm test` | `npm run test --workspaces` — runs each workspace's Vitest in its own dir: server (pg-mem integration test), react-sdk (jsdom hook tests), web (no tests, `--passWithNoTests`) |
| `npm run build` | Builds all workspaces in order: server `tsc`, react-sdk `tsc`, web production bundle |
| `npm run typecheck` | All workspaces |

Run one workspace with `npm test --workspace <name>`, e.g.
`npm test --workspace @omni-arena/react`.

## Testing notes

- Server tests use in-memory ports and `pg-mem`; no running Postgres or API
  keys needed.
- The hook tests moved out of `web/` into the SDK:
  `packages/react-sdk/src/useArenaChat.test.ts`. They run under jsdom and stub
  `fetch` with real SSE `ReadableStream` bodies. `localStorage` is stubbed
  because Node 24's experimental global shadows jsdom's implementation.
- **Gotcha — run tests per workspace, not a bare `vitest` at the repo root.**
  The `jsdom` environment is configured per workspace (in each workspace's
  `vitest.config.ts`), and there is no root Vitest config. Running `vitest`
  directly from the repo root picks up the default Node environment and the SDK
  hook test fails with `ReferenceError: document is not defined`. Use the
  per-workspace scripts instead — `npm test` (which delegates to
  `npm run test --workspaces`) or `npm test --workspace @omni-arena/react` — both
  of which run in the workspace dir with the right jsdom config and pass.
- Rating worker tests (`worker/tests/`) are pure Python via `pytest`: no live
  database. They check the analytic gradient against finite differences,
  recover known synthetic ratings, verify tie modeling and anchoring, confirm
  Fisher-information CIs agree with the multinomial bootstrap, check
  connectivity splits a disconnected graph, verify style control shrinks a pure
  verbosity advantage, and flag synthetic spam/bot sessions in the anomaly
  screen.
