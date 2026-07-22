# OmniArena × assistant-ui

A minimal [Vite](https://vite.dev) + React app that runs OmniArena **arena mode**
through [assistant-ui](https://github.com/assistant-ui/assistant-ui)'s AI SDK
runtime. It's the flagship "arena mode in a few lines" reference: assistant-ui's
headless primitives render the conversation, driven by the same Vercel AI SDK
stream OmniArena's adapter emits (`?protocol=vercel-ai`).

## How it works

- A stock `@ai-sdk/react` `useChat` is pointed at OmniArena's Vercel AI SDK
  adapter. A `prepareSendMessagesRequest` reshapes the outgoing request to
  OmniArena's `{ prompt }` body — the only OmniArena-specific line.
- `useAISDKRuntime(chat)` from `@assistant-ui/react-ai-sdk` adopts that chat
  instance, so assistant-ui's `<ThreadPrimitive>` renders **Model A** (the main
  text channel) with no extra glue.
- **Model B** rides the adapter's `data-arena-b-delta` parts; we read them off
  the same `chat.messages` and render them in a side column. The matchup id +
  vote token arrive in the `data-arena-meta` part and power the vote buttons.

Vite proxies `/api` and `/health` to the OmniArena server (see
`vite.config.ts`), so the browser stays same-origin and never hits CORS.

> **AG-UI note:** assistant-ui also ships an AG-UI runtime
> (`@assistant-ui/react-ag-ui`). OmniArena exposes an AG-UI adapter at
> `?protocol=ag-ui` (two `slot`-tagged messages in one run). This example uses
> the AI SDK runtime because it's the smallest complete round-trip (it also
> carries the vote token); the AG-UI adapter is covered by the repo e2e suite.

## Prerequisites

A running OmniArena server. For a zero-key local run, start it with the mock
provider (from the repo root):

```bash
docker compose up -d postgres            # or point DATABASE_URL at any Postgres
ARENA_MOCK_PROVIDER=1 npm run db:migrate --workspace server
ARENA_MOCK_PROVIDER=1 npm run db:seed:mock --workspace server
ARENA_MOCK_PROVIDER=1 npm run dev --workspace server   # listens on :3001
```

## Run

```bash
cd examples/assistant-ui
cp .env.example .env          # set ARENA_TARGET if not http://127.0.0.1:3001
npm install
npm run dev                   # http://localhost:5173
```

## Production build

```bash
npm run build && npm run preview
```

This example is exercised by the repo's e2e suite (`npm run e2e` from the root),
which boots OmniArena with the deterministic mock provider and drives this UI in
a headless browser.
