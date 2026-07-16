# OmniArena

OmniArena is a small, self-hosted service for blind side-by-side LLM
comparisons. It streams two anonymous answers over one connection, records
a vote, continues multi-turn chats from the winning response, and ranks models
with a statistically principled Bradley-Terry rating engine.

The stream is exposed through pluggable protocol adapters — native SSE, AG-UI,
A2UI, the Vercel AI SDK, and OpenAI-compatible SSE — and a headless React SDK
(`@omni-arena/react`) makes embedding the arena a few lines of code.

## Run locally

Requirements: Node.js 20+, npm, and Docker. (`docker compose` builds and runs
the Python rating worker for you; Python 3.10+ on the host is only needed to run
the worker outside Docker.)

```bash
cp .env.example .env
# Add your Google AI Studio API key to .env
npm install
docker compose up -d            # Postgres + the Bradley-Terry rating worker
npm run db:migrate --workspace server
npm run db:seed --workspace server
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The API listens on
`http://localhost:3001`.

The default seed enables three Gemini models, so set `GOOGLE_API_KEY` before
starting it. OpenAI-compatible, Ollama, vLLM, and host-proxy providers are also
available; edit `server/src/db/seed.ts` to use them and run the seed again.

## Ratings

A separate Python worker (`worker/`) periodically fits Bradley-Terry ratings
with Fisher-information confidence intervals from the recorded votes and writes
them to the `model_ratings` table. `docker compose up -d` starts it
automatically; ratings appear on the leaderboard after the first refit (until
then the leaderboard falls back to win rate). To run or test it directly, see
[`worker/README.md`](worker/README.md) and [`docs/md/setup.md`](docs/md/setup.md).

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
  OpenAI SSE are also available.
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
[`docs/md/sdk.md`](docs/md/sdk.md) for the API and a copy-paste integration.

## Documentation

Current-state docs live in [`docs/md/`](docs/md/) (with condensed visual
counterparts in [`docs/html/`](docs/html/)):
[architecture](docs/md/architecture.md) · [API](docs/md/api.md) ·
[data model](docs/md/data-model.md) · [setup](docs/md/setup.md) ·
[SDK](docs/md/sdk.md).

Planning documents (target architecture, MVP scope, PRD) are in
[`pre-docs/`](pre-docs/); the detailed MVP scope is
[`pre-docs/mvp.md`](pre-docs/mvp.md).