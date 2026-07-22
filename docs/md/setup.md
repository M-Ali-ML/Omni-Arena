# Setup

Requirements: Docker (Compose v2) for the one-command self-host. For the npm
development path: Node.js 20+, npm, Docker; Python 3.10+ to run the rating
worker outside Docker.

Related: [Architecture](architecture.md) · [API](api.md) · [Integration](integration.md) · [Rating methodology](rating-methodology.md) · [Data model](data-model.md) · [SDK](sdk.md)

## Quick start (Docker, single-tenant self-host)

OmniArena is self-hosted as a **single container per deployment** — one Fastify
process serves both the API and the built web UI on one port, so chat data never
leaves the adopter's infrastructure (decision record #5). `docker compose up`
brings up Postgres, the rating worker, and the app with no extra manual steps.

```bash
cp .env.example .env      # set GOOGLE_API_KEY and MATCHUP_TOKEN_SECRET at minimum
docker compose up
```

The `app` service builds from the repo-root `Dockerfile`, waits for Postgres to
be healthy, then its entrypoint runs migrations, seeds the model lineup, and
starts the server. Open http://localhost:3001 — the web UI and `/api/...` are on
the same origin and port (`PORT`, default `3001`).

### How the image is built

The multi-stage `Dockerfile` builds all workspaces (`server` → `react-sdk` →
`web`) in a `node:22` builder, copies the migration `.sql` files next to the
compiled `dist` (tsc does not copy them), prunes dev dependencies, and copies
the result into a slim runtime image. At runtime the server serves `web/dist`
via `@fastify/static` **only when the bundle is present** (production/Docker),
with an SPA fallback that returns `index.html` for non-`/api`, non-`/health` GET
routes. In the npm dev path the bundle is absent, so Vite serves the UI on
`:5173` and static serving stays off — the API is unaffected either way. Override
the bundle location with `WEB_DIST_DIR` for non-standard layouts.

## Quick start (npm, for development)

Run Postgres + the worker in Docker and the Node/Vite dev servers on the host
for hot reload:

```bash
cp .env.example .env               # configure the provider used by the seed lineup
npm install
docker compose up -d postgres worker   # Postgres 16 + rating worker
npm run db:migrate --workspace server
npm run db:seed --workspace server
npm run dev               # server on :3001, web on :5173
```

Open http://localhost:5173 (Vite proxies `/api` and `/health` to `:3001`).

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
(`server/src/env.ts`); Docker Compose loads the same `.env` into the containers.
`.env.example` documents every variable below.

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
| `LOG_LEVEL` | no | `INFO` | Rating worker log level (`DEBUG`/`INFO`/`WARNING`/`ERROR`) |
| `LOG_FORMAT` | no | `text` | Rating worker log format (`text` or `json`) |
| `MATCHMAKER` | no | `smart` | Matchmaking strategy: `smart` (under-sampled / high-variance pairs) or `random` (uniform) |
| `DATABASE_URL` | yes | — | Postgres connection string. **npm dev:** `postgres://omni_arena:omni_arena@localhost:5432/omni_arena`. **Docker Compose:** the `app`/`worker` services override the host to the compose hostname `postgres` (`…@postgres:5432/…`) |
| `MATCHUP_TOKEN_SECRET` | production | insecure dev default | HMAC secret for matchup tokens, minimum 16 characters |
| `PORT` | no | `3001` | Port the app listens on; also the published host port in Docker. The web UI and API share it |
| `WEB_ORIGIN` | no | `http://localhost:5173` | Allowed CORS origin (only relevant when the UI is served from a different origin; the single container serves both same-origin) |
| `WEB_DIST_DIR` | no | `../../web/dist` (relative to the compiled server) | Override the built web bundle directory; correct by default for the repo and the Docker image |
| `ARENA_MOCK_PROVIDER` | no | off | Set to `1`/`true` to register the deterministic `mock` provider for demos, examples, and CI/e2e (no LLM key needed). See [Mock provider](#mock-provider). |

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
- **Seed (mock):** `npm run db:seed:mock --workspace server` — disables every
  other model and seeds two `mock`-provider models (`Mock Model Alpha`,
  `Mock Model Beta`). Pair it with `ARENA_MOCK_PROVIDER=1`. See
  [Mock provider](#mock-provider).

## Mock provider

For local demos, the reference examples, and CI/e2e there is a **deterministic
stub provider** that never touches the network and streams a fixed, per-model set
of tokens, so a full arena round-trip (stream → vote → reveal) completes without
any real LLM API key.

- Enable it by setting `ARENA_MOCK_PROVIDER=1` (or `true`) — this registers the
  `mock` provider in `server/src/providers/configure.ts`. It is off by default so
  it never shadows a real provider in production.
- Seed the two mock models with `npm run db:seed:mock --workspace server`
  (`server/src/db/seed.mock.ts`), which also disables every other model so
  matchmaking only ever picks the mock pair.

```bash
docker compose up -d postgres                         # or any Postgres
ARENA_MOCK_PROVIDER=1 npm run db:migrate --workspace server
ARENA_MOCK_PROVIDER=1 npm run db:seed:mock --workspace server
ARENA_MOCK_PROVIDER=1 npm run dev --workspace server  # listens on :3001
```

Both [`examples/`](../../examples/) apps and the [e2e suite](#end-to-end-tests)
rely on this provider for a zero-key run.

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
| `npm run e2e` | End-to-end suite: builds both example apps, boots OmniArena (pg-mem + mock provider) and the example servers, and drives the full arena flow in headless Chromium. See [End-to-end tests](#end-to-end-tests). |

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

## Reference examples

Two runnable integrations live in [`examples/`](../../examples/); both talk to a
running OmniArena server (use the [mock provider](#mock-provider) for a zero-key
run):

- [`examples/vercel-ai-chatbot/`](../../examples/vercel-ai-chatbot/) — a Next.js
  16 App Router app whose server route forwards a stock `@ai-sdk/react` `useChat`
  client to OmniArena's Vercel AI SDK adapter (`?protocol=vercel-ai`).
- [`examples/assistant-ui/`](../../examples/assistant-ui/) — a Vite + React app
  running arena mode through assistant-ui's AI SDK runtime against the same
  `vercel-ai` endpoint.

See the [integration guide](integration.md) for how each adapter maps to these
apps.

## End-to-end tests

`npm run e2e` (from the repo root, orchestrated by `e2e/run.mjs`) is a
deterministic, CI-friendly suite with no real API keys or external LLM calls:

1. installs deps for the e2e harness and both example apps (skipped if present;
   force with `E2E_FORCE_INSTALL=1`),
2. builds each example app (the "each example builds" smoke check),
3. installs the Playwright Chromium browser,
4. runs Playwright, which boots the OmniArena harness (pg-mem + the `mock`
   provider) and both example servers, then drives the full arena flow.

`e2e/tests/protocol.spec.ts` asserts the raw `vercel-ai` and `ag-ui` wire streams
over HTTP (including that the Vercel path is votable and updates the
leaderboard); `e2e/tests/examples.spec.ts` drives both example UIs in a headless
browser through stream → vote → reveal.
