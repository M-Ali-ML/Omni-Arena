# OmniArena

OmniArena is a small, self-hosted service for blind side-by-side LLM
comparisons. The MVP streams two anonymous answers over one SSE connection,
records a vote, reveals the model identities, and updates a win-rate
leaderboard.

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

The seed enables Gemini 3.5 Flash, Gemini 3.1 Flash-Lite, and Gemini 2.5 Pro.
Set `GOOGLE_API_KEY` in `.env` before starting the server. To change the arena
lineup, edit `server/src/db/seed.ts` and run the seed command again.

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

The detailed MVP scope is in [`pre-docs/mvp.md`](pre-docs/mvp.md).
