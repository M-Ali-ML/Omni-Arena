# OmniArena × CopilotKit (AG-UI flagship)

Owned Next.js App Router chat app using CopilotKit's stock UI (`@copilotkit/react-core`
v2 `CopilotChat`), with `ArenaHttpAgent` registered in `CopilotRuntime` at
`/api/copilotkit` and pointed at OmniArena's AG-UI adapter
(`/api/arena/chat?protocol=ag-ui`).

What you get in the browser: one prompt, **two anonymous answers streaming side
by side** inside CopilotKit's message list, a five-way vote bar wired to
`POST /api/arena/vote`, **model reveal after the vote**, and a follow-up that
**continues the winning response** in the same OmniArena conversation. Rounds
the arena marks `votable: false` (single-model) render one column with no vote
UI.

Nothing here is a stub: the app is this directory, CopilotKit and `@ag-ui/client`
are pinned npm packages, and the server is OmniArena's real Fastify app (mock
harness or your own Postgres).

## What it looks like

Every image below is this integration running for real — CopilotKit's composer
and message primitives on one side, OmniArena's AG-UI stream on the other.

One prompt, two anonymous slot messages (`messageId` = `<matchupId>:A|B`)
streaming concurrently. The vote bar is already in place, disabled until both
slots finish:

![Two anonymous answers streaming side by side in CopilotKit, the vote bar disabled while both slots are still writing](../../docs/images/integrations/copilotkit/01-streaming.png)

Both answers done, both still labelled `anonymous`, and the five-way vote
enabled — A is better, B is better, Both good, Both bad, Skip:

![The finished pair with the five-way vote bar enabled and both models still anonymous](../../docs/images/integrations/copilotkit/02-vote.png)

The vote goes to the same-origin `POST /api/arena/vote` proxy, which answers
with the models. Only then are the columns named, and the one you picked is
badged. Tokens come from server-side `x-arena-matchup` capture into a matchup
cache (the client polls `GET /api/arena/matchup` after each run; CopilotKit
**1.63.2** also forwards `CUSTOM arena_matchup` to the browser):

![After the vote: both columns named with their models and the picked column badged](../../docs/images/integrations/copilotkit/03-reveal.png)

Because that vote was decisive it left a winning response, so the follow-up is
turn 2 of the *same* OmniArena conversation — continued from the winner, with a
fresh blind matchup for the new turn:

![A follow-up question answered as turn 2 of the same conversation, below the previous round's reveal](../../docs/images/integrations/copilotkit/04-multi-turn.png)

Toggle **Arena mode** off and OmniArena serves a single model: the stream
carries `mode: "single"` and `votable: false`, so the UI drops to one column and
replaces the vote bar with an explanation rather than offering a vote that
cannot be cast:

![Arena mode off: one column with a single-model notice instead of a vote bar](../../docs/images/integrations/copilotkit/05-single-model.png)

## Requirements

- Node 20+ and `npm`
- **No API keys** for the default path — OmniArena's deterministic mock provider
  over in-memory Postgres (`pg-mem`).
- `@omni-arena/react` built from the repo root when you first wire the app:
  `npm run build --workspace @omni-arena/react`

## Quickstart (mock provider, no credits spent)

```bash
cd integrations/copilotkit
npm install

npm run arena        # OmniArena on http://127.0.0.1:3031  (mock provider, pg-mem)
npm run dev          # app on http://127.0.0.1:3300
```

Open <http://127.0.0.1:3300>.

### What to click

1. The header shows `Arena mode: on`. Send a prompt (or use a suggestion).
2. Two columns appear — **RESPONSE A** and **RESPONSE B**, both labelled
   `anonymous`, streaming at the same time from one AG-UI run (two assistant
   messages in CopilotKit's list).
3. When both finish, the vote bar enables: **A is better / B is better / Both
   good / Both bad / Skip**.
4. Vote. The models are revealed inline and your pick is badged.
5. After a decisive vote (A or B) the header switches to
   `continuing conversation <id>` — send a follow-up and OmniArena continues
   turn 2 from the winning response, with a fresh blind matchup for the new turn.
   After a tie/skip there is no winner, so the next message starts fresh.
6. Reload the page: the thread comes back from OmniArena's conversation GET
   (same prompts, answers, and reveals).
7. Click **Arena mode: on** to toggle it off, then send a message: OmniArena
   serves a single model, the stream carries `mode: "single"`, `votable: false`,
   and the UI renders one column with the vote bar replaced by an explanation.
8. **New Thread** starts a new CopilotKit thread with its own arena state.

With `ARENA_TRIGGER=manual` (what `harness/arena.ts` and `npm test` use), the
**Arena mode** toggle sets `x-arena: on` on proxied chat requests via
`<CopilotKit headers={…}>`. Equivalent direct call:

```bash
curl -N 'http://127.0.0.1:3031/api/arena/chat?protocol=ag-ui' \
  -H 'content-type: application/json' -H 'x-arena: on' \
  -d '{"prompt":"Hello"}'
```

## Test

```bash
npm test            # builds the app, then runs the Playwright flow
npm test -- --dev   # same suite against `next dev` (skips the production build)
```

Playwright starts both servers itself (OmniArena on **3031**, the app on
**3300**) and covers: prompt → two concurrent streams → blind headers → vote →
reveal → multi-turn continuation (asserting `turnIndex: 1` in the same
conversation), the tie path (reveal but no continuation), the non-votable
single-model round, reload rehydration from `GET /api/arena/conversations/:id`,
and protocol-level tests that assert the AG-UI event sequence, server-side
`x-arena-matchup` capture, `GET /api/arena/matchup` poll, and `CUSTOM
arena_matchup` delivery on CopilotKit 1.63.2.

There is also a headless probe of the agent path that needs no browser:

```bash
npm run arena       # in one terminal
npm run probe       # nine-check PASS/FAIL: stream, header cache, CUSTOM, vote, continuation
```

`tools/probe.ts` drives the same `ArenaHttpAgent` CopilotRuntime registers,
directly against OmniArena's AG-UI endpoint (the CopilotKit runtime HTTP envelope
is impractical to call headlessly). Set `APP_URL=http://127.0.0.1:3300` to
exercise the vote through the app's same-origin proxy.

## Layout

```
integrations/copilotkit/
  app/api/copilotkit/     CopilotRuntime + ArenaHttpAgent (AgentsFactory)
  app/api/arena/matchup/  read server-side matchup cache (vote-token poll)
  app/api/arena/vote/     same-origin vote proxy
  app/api/arena/conversations/  same-origin conversation rehydration
  components/arena/       dual-column message, vote bar, controls, bridge
  lib/arena/              agent, protocol, store, matchup-cache
  harness/arena.ts        OmniArena on pg-mem + mock provider, port 3031
  tools/probe.ts          headless agent + vote + continuation proof
  tests/                  Playwright specs
  FINDINGS.md             CopilotKit × AG-UI observations
```

### How the wiring works

- `CopilotRuntime` at `/api/copilotkit` registers an `ArenaHttpAgent` — a
  subclass of `@ag-ui/client`'s `HttpAgent` that injects arena fields into
  `forwardedProps` (`sessionId`, `conversationId`, `arena`) and the `x-arena`
  header. An **AgentsFactory** reads per-request headers from `<CopilotKit
  headers={…}>` (`x-arena`, `x-arena-session`, `x-arena-conversation`,
  `x-arena-thread`) because the agent runs server-side.
- OmniArena's AG-UI call happens inside that agent, not in the browser. The
  browser cannot read `x-arena-matchup` off OmniArena's response. **`ArenaHttpAgent`'s
  custom `fetch`** parses the header (via `@omni-arena/react`'s
  `parseArenaMatchup`) into an in-process **matchup cache** keyed by CopilotKit
  `threadId`. After each run the client polls **`GET /api/arena/matchup?threadId=…`**
  to hydrate `lib/arena/store.ts`. CopilotKit **1.63.2** also forwards
  **`CUSTOM arena_matchup`** to the browser (`ArenaMatchupBridge` subscribes as
  belt-and-suspenders); the header-capture path stays load-bearing if a future
  release tightens CUSTOM filtering.
- Votes use **`POST /api/arena/vote`** on the same origin (thin proxy to OmniArena).
  After a vote, continuation follows the server's `continuable` flag on the vote
  response, not a client-side left|right rule.
- Unlike assistant-ui's AG-UI aggregator (one assistant message, two text parts),
  CopilotKit keeps slot A and slot B as **two assistant messages**. The custom
  `assistantMessage` slot renders A as a dual column and returns `null` for B so
  the list does not stack two bubbles.
- Reload rehydration: active `conversationId` (and pending vote tokens) live in
  `localStorage`; conversation GET rebuilds the arena store and CopilotKit's
  message list.
- `OMNIARENA_URL` stays server-side (`lib/arena/server.ts`); the browser only
  talks to `/api/copilotkit` and the arena proxy routes.

## Pointing it at real models (real credentials, your money)

The mock path above uses `harness/arena.ts`. For real providers, run OmniArena
proper and point the app at it. Nothing in this directory changes except env vars.

1. **Postgres of your own** (this integration is allocated port `5443` so it can
   run beside assistant-ui on `5442`):

   ```bash
   docker run -d --name omniarena-copilotkit-db \
     -e POSTGRES_USER=omni_arena -e POSTGRES_PASSWORD=omni_arena \
     -e POSTGRES_DB=omni_arena -p 5443:5432 postgres:16
   ```

2. **Migrate and seed the roster** from the repo root:

   ```bash
   export DATABASE_URL=postgres://omni_arena:omni_arena@localhost:5443/omni_arena
   npm --workspace server run db:migrate
   npm --workspace server run db:seed   # three Gemini models by default
   ```

   `server/src/db/seed.ts` is the roster. Edit it (or insert rows yourself) to
   choose the models that will face off; each row's `provider` must match a
   registered provider and `enabled` must be true. At least two enabled models
   are required for a matchup. (`npm --workspace server run db:seed:mock` seeds
   the two mock models instead, if you want the real-Postgres path without keys.)

   Grab a model id for `ARENA_DEFAULT_MODEL` below with:

   ```bash
   psql "$DATABASE_URL" -c "select id, display_name from models where enabled"
   ```

3. **Start OmniArena on port 3031 with real keys** (from the repo root):

   ```bash
   DATABASE_URL=postgres://omni_arena:omni_arena@localhost:5443/omni_arena \
   PORT=3031 \
   MATCHUP_TOKEN_SECRET=<32+ random chars> \
   WEB_ORIGIN=http://127.0.0.1:3300 \
   ARENA_TRIGGER=manual \
   ARENA_DEFAULT_MODEL=<uuid of an enabled model> \
   GOOGLE_API_KEY=<key> \
   npm --workspace server run dev
   ```

   - **Disabling the mock provider is the default**: it only registers when
     `ARENA_MOCK_PROVIDER=1`. Just don't set it. (`harness/arena.ts` registers
     the mock provider in-process and never reads your `.env`.)
   - Other providers: `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`),
     `VLLM_BASE_URL` (+ `VLLM_API_KEY`), `OLLAMA_BASE_URL` (default
     `http://localhost:11434`), `HOST_PROXY_URL` (+ `HOST_PROXY_TOKEN`).
   - `ARENA_TRIGGER=always` makes every request a votable matchup and the app's
     Arena-mode toggle becomes cosmetic. With `manual` (what the mock harness
     uses) the toggle sends `x-arena: on` and off-mode serves
     `ARENA_DEFAULT_MODEL`.

4. **Run the app against it**:

   ```bash
   cd integrations/copilotkit
   OMNIARENA_URL=http://127.0.0.1:3031 npm run dev
   ```

`WEB_ORIGIN` only matters for browser-direct calls; this app proxies
server-side, so it is set above merely for consistency.

## Pinned versions, and how to bump them

This directory pins dependencies in `package.json` (owned app, not an upstream
clone):

| Package | Version | Notes |
| --- | --- | --- |
| `@copilotkit/react-core` | **1.63.2** | v2 chat + `useAgent` |
| `@copilotkit/react-ui` | **1.63.2** | Styles / legacy surface |
| `@copilotkit/runtime` | **1.63.2** | `CopilotRuntime` + `ExperimentalEmptyAdapter` |
| `@ag-ui/client` | **0.0.57** | Same pin as CopilotKit 1.63.2 and assistant-ui |
| `next` | **16.2.10** | Matches assistant-ui |
| `react` / `react-dom` | **19.2.8** | Next 16 peer range |
| `@playwright/test` | **1.61.1** | E2E suite (devDependency) |

To bump CopilotKit or AG-UI: edit `package.json`, `npm install`, then run
`npm test` and `npm run probe`.

## Findings about OmniArena

The point of this integration was to test the AG-UI adapter against CopilotKit's
server-side runtime. What broke, what is missing, and what the wire actually
looks like: **[FINDINGS.md](./FINDINGS.md)**.
