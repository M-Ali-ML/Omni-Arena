# Setup

Requirements: Node.js 20+, npm, Docker. Python 3.10+ for the rating worker.

Related: [Architecture](architecture.md) · [API](api.md) · [Data model](data-model.md)

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
aggregates votes in-database, fits ratings with Fisher-information confidence
intervals, and upserts the `model_ratings` table the leaderboard reads.

```bash
cd worker
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# One-shot (requires migrations applied and DATABASE_URL set):
DATABASE_URL=postgres://omni_arena:omni_arena@localhost:5432/omni_arena \
  python -m omniarena_rating

# Periodic loop with warm-started refits:
python -m omniarena_rating --loop --interval 300 --ridge 0.01

# Tests (pure Python, no database):
python -m pytest
```

`docker compose up -d` also starts a `worker` service that runs the loop
against the `postgres` service automatically. Ratings appear on the leaderboard
after the first successful refit; until then the rating fields are null.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Server (`tsx watch`) and web (Vite) concurrently |
| `npm test` | Server (Vitest, includes pg-mem integration test) and web (Vitest + jsdom hook tests) |
| `npm run build` | Server `tsc` build and web production bundle |
| `npm run typecheck` | Both workspaces |

## Testing notes

- Server tests use in-memory ports and `pg-mem`; no running Postgres or API
  keys needed.
- Web hook tests (`web/src/useArenaChat.test.ts`) run under jsdom and stub
  `fetch` with real SSE `ReadableStream` bodies. `localStorage` is stubbed
  because Node 24's experimental global shadows jsdom's implementation.
- Rating worker tests (`worker/tests/`) are pure Python via `pytest`: no live
  database. They check the analytic gradient against finite differences,
  recover known synthetic ratings, verify tie modeling and anchoring, confirm
  Fisher-information CIs agree with the multinomial bootstrap, and check
  connectivity splits a disconnected graph.
