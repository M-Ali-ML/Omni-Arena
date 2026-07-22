# OmniArena

OmniArena is a small, self-hosted service for blind side-by-side LLM
comparisons. It streams two anonymous answers over one connection, records
a vote, continues multi-turn chats from the winning response, and ranks models
with a statistically principled Bradley-Terry rating engine.

The stream is exposed through pluggable protocol adapters — native SSE, AG-UI,
A2UI, the Vercel AI SDK, and OpenAI-compatible SSE — and a headless React SDK
(`@omni-arena/react`) makes embedding the arena a few lines of code.

## Run it (Docker, one command)

OmniArena ships as a single self-hosted container that bundles the API and the
web UI (single-tenant per deployment; chat data never leaves your infra). With
Docker you get Postgres, the rating worker, and the app with one command.

Requirements: Docker (Compose v2).

```bash
cp .env.example .env
# Add your Google AI Studio API key (GOOGLE_API_KEY) and a MATCHUP_TOKEN_SECRET
docker compose up
```

That builds the image, waits for Postgres, runs migrations, seeds the model
lineup, and starts the app. Open [http://localhost:3001](http://localhost:3001)
— the web UI and the `/api/...` routes are served from the same port.

The default seed enables three Gemini models, so set `GOOGLE_API_KEY` before
starting. OpenAI-compatible, Ollama, vLLM, and host-proxy providers are also
available; edit `server/src/db/seed.ts` to use them and re-run the seed.

## Run it (npm, for development)

For hot-reloading development, run Postgres + the worker in Docker and the
Node/Vite dev servers on the host.

Requirements: Node.js 20+, npm, and Docker. (Python 3.10+ on the host is only
needed to run the rating worker outside Docker.)

```bash
cp .env.example .env
# Add your Google AI Studio API key to .env
npm install
docker compose up -d postgres worker   # Postgres + the Bradley-Terry rating worker
npm run db:migrate --workspace server
npm run db:seed --workspace server
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The API listens on
`http://localhost:3001` and Vite proxies `/api` to it.

## Ratings

A separate Python worker (`worker/`) periodically fits Bradley-Terry ratings
with Fisher-information confidence intervals from the recorded votes and writes
them to the `model_ratings` table. `docker compose up -d` starts it
automatically; ratings appear on the leaderboard after the first refit (until
then the leaderboard falls back to win rate). For the full statistical story see
the [rating methodology](docs/md/rating-methodology.md); to run or test the
worker directly, see [`worker/README.md`](worker/README.md) and
[`docs/md/setup.md`](docs/md/setup.md).

## Commands

```bash
npm test       # backend tests
npm run build  # server and web production builds
npm run typecheck
cd worker && python -m pytest   # rating worker tests (pure Python, no database)
```



## API

- `POST /api/arena/chat` starts a matchup and streams both responses over one
  connection. The wire format is chosen with a `?protocol=` query param (or the
  `Accept` header), defaulting to native SSE; AG-UI, A2UI, Vercel AI SDK, and
  OpenAI SSE are also available. See the
  [integration guide](docs/md/integration.md) for a per-protocol walkthrough.
- `POST /api/arena/vote` records one vote and reveals model identities.
- `GET /api/arena/leaderboard` returns win/loss/tie counts and win rates, plus
  Bradley-Terry `rating`, `confidenceInterval`, and `componentId` fields (null
  until the rating worker has run).
- `GET /api/arena/control` is a WebSocket control plane for stopping an
  in-flight matchup (mid-stream steering is a documented stub for now).

## Embedding

The arena hooks are published as a headless React package,
[`@omni-arena/react`](packages/react-sdk) (`useArenaChat`,
`useArenaLeaderboard`). The demo `web/` app is the reference consumer; see
[`docs/md/sdk.md`](docs/md/sdk.md) for the API and a copy-paste integration. To
embed the arena into an existing chat stack over one of the wire protocols
instead, see the [integration guide](docs/md/integration.md).

## Examples

Two runnable reference integrations live in [`examples/`](examples/):

- [`examples/vercel-ai-chatbot/`](examples/vercel-ai-chatbot/) — a Next.js 16 +
  Vercel AI SDK app driving arena mode through the `?protocol=vercel-ai` adapter.
- [`examples/assistant-ui/`](examples/assistant-ui/) — a Vite + React app running
  arena mode through assistant-ui's AI SDK runtime.

Both run key-free against the deterministic mock provider and are exercised by
the end-to-end suite (`npm run e2e`). See
[`docs/md/setup.md`](docs/md/setup.md#reference-examples).

## Documentation

Current-state docs live in [`docs/md/`](docs/md/) (with condensed visual
counterparts in [`docs/html/`](docs/html/)):
[architecture](docs/md/architecture.md) · [API](docs/md/api.md) ·
[integration](docs/md/integration.md) ·
[rating methodology](docs/md/rating-methodology.md) ·
[data model](docs/md/data-model.md) · [setup](docs/md/setup.md) ·
[SDK](docs/md/sdk.md).

Planning documents (target architecture, MVP scope, PRD) are in
[`pre-docs/`](pre-docs/); the detailed MVP scope is
[`pre-docs/mvp.md`](pre-docs/mvp.md).