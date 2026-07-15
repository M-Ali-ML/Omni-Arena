# OmniArena

OmniArena is a small, self-hosted service for blind side-by-side LLM
comparisons. It streams two anonymous answers over one SSE connection, records
a vote, continues multi-turn chats from the winning response, and captures the
metadata needed for future style-controlled ratings.

## Run locally

Requirements: Node.js 20+, npm, and Docker.

```bash
cp .env.example .env
# Add your Google AI Studio API key to .env
npm install
docker compose up -d
npm run db:migrate --workspace server
npm run db:seed --workspace server
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The API listens on
`http://localhost:3001`.

The default seed enables three Gemini models, so set `GOOGLE_API_KEY` before
starting it. OpenAI-compatible, Ollama, vLLM, and host-proxy providers are also
available; edit `server/src/db/seed.ts` to use them and run the seed again.

## Commands

```bash
npm test       # backend tests
npm run build  # server and web production builds
npm run typecheck
```

## API

- `POST /api/arena/chat` starts a matchup and streams multiplexed SSE events.
- `POST /api/arena/vote` records one vote and reveals model identities.
- `GET /api/arena/leaderboard` returns win/loss/tie counts and win rates.

## Documentation

Current-state docs live in [`docs/md/`](docs/md/) (with condensed visual
counterparts in [`docs/html/`](docs/html/)):
[architecture](docs/md/architecture.md) · [API](docs/md/api.md) ·
[data model](docs/md/data-model.md) · [setup](docs/md/setup.md).

Planning documents (target architecture, MVP scope, PRD) are in
[`pre-docs/`](pre-docs/); the detailed MVP scope is
[`pre-docs/mvp.md`](pre-docs/mvp.md). The long-form vision doc lives at
`artifacts/vision.md` (local-only, gitignored — not committed).
