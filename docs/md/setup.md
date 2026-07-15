# Setup

Requirements: Node.js 20+, npm, Docker.

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
