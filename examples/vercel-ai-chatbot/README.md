# OmniArena × Vercel AI SDK (Next.js)

A minimal [Next.js](https://nextjs.org) App Router app that puts **arena mode**
— one prompt, two anonymous models, blind vote — behind a stock
[Vercel AI SDK](https://sdk.vercel.ai) `useChat` client. It is the smallest
honest test that OmniArena's **Vercel AI SDK adapter** (`?protocol=vercel-ai`)
works, and it mirrors how you'd wire arena mode into the
[Vercel AI Chatbot template](https://github.com/vercel/ai-chatbot): the client
is unmodified `useChat`; a server route forwards to OmniArena.

## How it works

- `app/api/arena/chat/route.ts` — server route (the template's `api/chat`
  equivalent). It reads the AI SDK request, extracts the latest user prompt, and
  forwards it to `${OMNIARENA_URL}/api/arena/chat?protocol=vercel-ai`, piping the
  **UI Message Stream** straight back to the browser.
- `app/page.tsx` — a stock `useChat` client. OmniArena's adapter puts **Model A**
  on the primary text channel (rendered as the assistant message) and **Model B**
  in custom `data-arena-b-delta` parts (rendered in the second column). The
  matchup id + vote token arrive in a `data-arena-meta` part, which powers the
  vote buttons.
- `app/api/arena/vote/route.ts` — proxies the vote and reveals both identities.

Because the browser only talks to this Next app (which proxies server-side), you
never hit CORS and the OmniArena token stays on your origin.

## Prerequisites

A running OmniArena server. For a zero-key local run, start it with the mock
provider (from the repo root):

```bash
docker compose up -d postgres            # or point DATABASE_URL at any Postgres
ARENA_MOCK_PROVIDER=1 npm run db:migrate --workspace server
ARENA_MOCK_PROVIDER=1 npm run db:seed:mock --workspace server
ARENA_MOCK_PROVIDER=1 npm run dev --workspace server   # listens on :3001
```

(For real models, seed the default Gemini roster and set `GOOGLE_API_KEY`
instead — see the repo README.)

## Run

```bash
cd examples/vercel-ai-chatbot
cp .env.example .env         # set OMNIARENA_URL if not http://127.0.0.1:3001
npm install
npm run dev                  # http://localhost:3000
```

Type a prompt, watch both models stream, then vote to reveal who was who.

## Production build

```bash
npm run build && npm run start
```

This example is exercised by the repo's e2e suite (`npm run e2e` from the root),
which boots OmniArena with the deterministic mock provider and drives this UI in
a headless browser.
