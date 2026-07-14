# Setup

Requirements: Node.js 20+, npm, Docker.

Related: [Architecture](architecture.md) · [API](api.md) · [Data model](data-model.md)

## Quick start

```bash
cp .env.example .env      # then set GOOGLE_API_KEY
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
| `GOOGLE_API_KEY` | yes | — | Gemini API key ([create one](https://aistudio.google.com/apikey)) |
| `DATABASE_URL` | yes | — | Postgres connection string; docker-compose default is `postgres://omni_arena:omni_arena@localhost:5432/omni_arena` |
| `MATCHUP_TOKEN_SECRET` | production | insecure dev default | HMAC secret for matchup tokens, minimum 16 characters |
| `PORT` | no | `3001` | API port |
| `WEB_ORIGIN` | no | `http://localhost:5173` | Allowed CORS origin |

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
