# OmniArena × assistant-ui (AG-UI runtime)

The real [assistant-ui](https://github.com/assistant-ui/assistant-ui) monorepo,
cloned at a pinned commit, with its `examples/with-ag-ui` app re-pointed from the
example's Python echo agent at **OmniArena's AG-UI adapter**
(`/api/arena/chat?protocol=ag-ui`).

What you get in the browser: one prompt, **two anonymous answers streaming side
by side** in assistant-ui's own message primitives, a vote bar wired to
`POST /api/arena/vote`, **model reveal after the vote**, and a follow-up message
that **continues the winning response** in the same OmniArena conversation.
Rounds the arena marks `votable: false` (single-model) render one column with no
vote UI.

Nothing here is a stub: the app is upstream assistant-ui, the runtime is
upstream `@assistant-ui/react-ag-ui`, the AG-UI client is upstream
`@ag-ui/client`, and the server is OmniArena's real Fastify app.

## What it looks like

Every image below is this integration running for real — upstream's thread,
composer and message primitives on one side, OmniArena's AG-UI stream on the
other — captured by [`npm run screenshots`](#regenerating-the-screenshots).

One prompt, two anonymous answers streaming concurrently out of a single AG-UI
run. The vote bar is already in place, disabled until both slots finish:

![Two anonymous answers streaming side by side in assistant-ui, the vote bar disabled while both slots are still writing](../../docs/images/integrations/assistant-ui/01-streaming.png)

Both answers done, both still labelled `anonymous`, and the five-way vote
enabled — A is better, B is better, Both good, Both bad, Skip:

![The finished pair with the five-way vote bar enabled and both models still anonymous](../../docs/images/integrations/assistant-ui/02-vote.png)

The vote goes to `POST /api/arena/vote`, which answers with the models. Only
then are the columns named, and the one you picked is badged:

![After the vote: both columns named with their models and the picked column badged](../../docs/images/integrations/assistant-ui/03-reveal.png)

Because that vote was decisive it left a winning response, so the follow-up is
turn 2 of the *same* OmniArena conversation — continued from the winner, with a
fresh blind matchup for the new turn:

![A follow-up question answered as turn 2 of the same conversation, below the previous round's reveal](../../docs/images/integrations/assistant-ui/04-multi-turn.png)

Toggle **Arena mode** off and OmniArena serves a single model: the stream
carries `mode: "single"` and `votable: false`, so the UI drops to one column and
replaces the vote bar with an explanation rather than offering a vote that
cannot be cast:

![Arena mode off: one column labelled Single model, with the vote bar replaced by an explanation](../../docs/images/integrations/assistant-ui/05-single-model.png)

### Regenerating the screenshots

```bash
npm run screenshots     # setup → build → capture → optimise
```

`scripts/screenshots.mjs` re-applies the overlay (so the images always show the
committed sources), builds the app and serves it with `next start` — no dev
overlay in frame — then runs `screenshots/capture.spec.ts` under
`screenshots.config.ts`: a 1280×800 light-mode viewport at
`deviceScaleFactor: 2`, on this integration's own ports (3011 and 3100, as
everywhere else here). The PNGs land in
`docs/images/integrations/assistant-ui/` and are re-encoded as quantised palette
PNGs, ~50–85 KB each.

The capture spec drives the app through the same selectors as
[`tests/arena.spec.ts`](./tests/arena.spec.ts). The one thing it changes is the
provider: it sets `ARENA_SHOWCASE=1`, which swaps OmniArena's stock mock for
`harness/showcase-provider.ts`. The reason is pacing. The stock mock is
identity-free — it opens with `Mock answer, variant <tag>`, a hash of the
provider model id rather than a name ([FINDINGS.md](./FINDINGS.md) §11) — but it
yields its four tokens with no delay, so there is no mid-stream moment to
photograph. The showcase provider streams longer canned markdown at a different
pace per model, so a capture catches two visibly live columns. Everything else in
the pictures is the real thing: real matchmaking, the real AG-UI adapter, signed
vote tokens, the real reveal.

## Requirements

- Node 20+ and `npm` (the setup script fetches the pinned `pnpm` on demand via `npx`)
- `git`
- **No API keys** for the default path — it runs OmniArena's deterministic mock
  provider over an in-memory Postgres (`pg-mem`).

## Quickstart (mock provider, no credits spent)

```bash
cd integrations/assistant-ui
npm install          # this directory's own tooling (Playwright, tsx, pg-mem, sharp)
npm run setup        # clone upstream at the pinned commit, overlay + patch, install, build
```

Then, in two terminals:

```bash
npm run arena        # OmniArena on http://127.0.0.1:3011  (mock provider, pg-mem)
npm run dev          # assistant-ui on http://127.0.0.1:3100
```

Open <http://127.0.0.1:3100>.

### What to click

1. The header shows `Arena mode: on`. Send a prompt (or use a suggestion).
2. Two columns appear — **RESPONSE A** and **RESPONSE B**, both labelled
   `anonymous`, streaming at the same time from one AG-UI run.
3. When both finish, the vote bar enables: **A is better / B is better / Both
   good / Both bad / Skip**.
4. Vote. The models are revealed inline (`A was …, B was …`) and your pick is
   badged.
5. After a decisive vote (A or B) the header switches to
   `continuing conversation <id>` — send a follow-up and OmniArena continues
   turn 2 from the winning response, with a fresh blind matchup for the new turn.
   After a tie/skip there is no winner, so the next message starts fresh.
6. Reload the page: the thread comes back from OmniArena's conversation GET
   (same prompts, answers, and reveals).
7. Click **Arena mode: on** to toggle it off, then send a message: OmniArena
   serves a single model, the stream carries `mode: "single"`, `votable: false`,
   and the UI renders one column with the vote bar replaced by an explanation.
8. **New Thread** starts a new assistant-ui thread with its own arena state.

## Test

```bash
npm test            # builds the app, then runs the Playwright flow
npm test -- --dev   # same suite against `next dev` (skips the production build)
```

Playwright starts both servers itself (OmniArena on 3011, the app on 3100) and
covers: prompt → two concurrent streams → blind headers → vote → reveal →
multi-turn continuation (asserting `turnIndex: 1` in the same conversation), the
tie path (reveal but no continuation), the non-votable single-model round,
reload rehydration from `GET /api/arena/conversations/:id`, and two
protocol-level tests that assert the AG-UI event sequence plus the
`x-arena-matchup` header the browser receives (`tests/protocol.spec.ts`).

There is also a headless probe of the adapter that needs no browser:

```bash
npm run arena       # in one terminal
npm run probe       # drives ?protocol=ag-ui through @ag-ui/client and votes
```

## Layout

```
integrations/assistant-ui/
  upstream.json                  pinned commit + pnpm version + app path
  scripts/setup.mjs              clone/refresh .upstream, overlay, patch, install, build
  scripts/overlay.mjs            file copy list + anchored patches into upstream files
  scripts/upstream-run.mjs       run next dev/build/start inside the clone
  scripts/e2e.mjs                one command: setup (if needed) → build → playwright
  scripts/screenshots.mjs        the same, pointed at screenshots.config.ts
  scripts/optimize-pngs.mjs      re-encodes the captured PNGs as palette PNGs
  harness/arena.ts               OmniArena on pg-mem + mock provider, port 3011
  harness/showcase-provider.ts   ARENA_SHOWCASE=1: blind, slow-streaming answers
  tools/agui-probe.ts            @ag-ui/client probe of the adapter (no browser)
  tests/                         Playwright specs
  screenshots/                   the documentation-screenshot spec
  overlay/examples/with-ag-ui/   the committed arena layer, copied into the clone
    lib/arena/protocol.ts        wire types + header/vote/conversation parsers
    lib/arena/store.ts           external store: matchups, votes, reveal, hydrate
    lib/arena/persistence.ts     conversationId + pending vote tokens across reload
    lib/arena/history.ts         ThreadHistoryAdapter → conversation GET
    lib/arena/agent.ts           thin ArenaHttpAgent + useArenaAgent
    lib/arena/server.ts          server-only OMNIARENA_URL resolution
    app/api/arena/chat/route.ts  same-origin proxy → OmniArena AG-UI stream
    app/api/arena/vote/route.ts  same-origin proxy → OmniArena vote
    app/api/arena/conversations/ same-origin proxy → conversation rehydration
    components/arena/*.tsx       dual-column assistant message, vote bar, header controls
  .upstream/                     the clone (gitignored, never committed)
```

### How the wiring works

- `useArenaAgent(threadId)` builds a thin `ArenaHttpAgent` — a subclass of
  `@ag-ui/client`'s `HttpAgent` that keeps a stock `RunAgentInput` body and only
  injects arena fields into `forwardedProps` (`sessionId`, `conversationId`,
  `arena`) plus the `x-arena` header. OmniArena's `agUiRequestAdapter` already
  accepts that envelope ([FINDINGS.md](./FINDINGS.md), finding 1); what
  `useAgUiRuntime` still cannot do is populate those props itself (it fills
  `forwardedProps` only from its own model context) or set a request header.
  That injection is the only reason the subclass remains.
- Vote tokens arrive on the chat response's `x-arena-matchup` header. The Next
  proxy forwards it; the agent's custom `fetch` parses it into
  `lib/arena/store.ts`. assistant-ui's aggregator still drops `CUSTOM` events,
  so the header is the path that works with the stock runtime — no raw
  `CUSTOM` subscriber for voting.
- After a vote, continuation follows the server's `continuable` flag on
  `POST /api/arena/vote` (not a client-side left|right rule).
- Reload rehydration: the active `conversationId` (and any still-needed vote
  token) lives in `localStorage`; a `ThreadHistoryAdapter` calls
  `GET /api/arena/conversations/:id` and rebuilds both the arena store and the
  assistant-ui message list.
- `MyRuntimeProvider.tsx` (upstream file, patched) hands that agent to
  upstream's `useAgUiRuntime`, so assistant-ui's own runtime parses the stream.
- The two slots arrive as two concurrent AG-UI text messages in one run, so
  upstream's aggregator produces **one assistant message with two text parts**.
  `ArenaAssistantMessage` renders part 0 and part 1 as the A and B columns via
  `MessagePrimitive.PartByIndex`.
- Both API routes are thin same-origin proxies; the browser never learns where
  OmniArena lives, and `OMNIARENA_URL` stays server-side.

## Pointing it at real models (real credentials, your money)

The mock path above uses `harness/arena.ts`. For real providers, run OmniArena
proper and point the app at it. Nothing in this directory changes.

1. **Postgres of your own** (this integration is allocated port `5442`):

   ```bash
   docker run -d --name omniarena-assistant-ui-db \
     -e POSTGRES_USER=omni_arena -e POSTGRES_PASSWORD=omni_arena \
     -e POSTGRES_DB=omni_arena -p 5442:5432 postgres:16
   ```

2. **Migrate and seed the roster** from the repo root:

   ```bash
   export DATABASE_URL=postgres://omni_arena:omni_arena@localhost:5442/omni_arena
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

3. **Start OmniArena on port 3011 with real keys** (from the repo root). The
   provider registry (`server/src/providers/configure.ts`) registers a provider
   when its variables are present:

   ```bash
   DATABASE_URL=postgres://omni_arena:omni_arena@localhost:5442/omni_arena \
   PORT=3011 \
   MATCHUP_TOKEN_SECRET=<32+ random chars> \
   WEB_ORIGIN=http://127.0.0.1:3100 \
   ARENA_TRIGGER=manual \
   ARENA_DEFAULT_MODEL=<uuid of an enabled model> \
   GOOGLE_API_KEY=<key> \
   npm --workspace server run dev
   ```

   - **Disabling the mock provider is the default**: it only registers when
     `ARENA_MOCK_PROVIDER=1`. Just don't set it. (`harness/arena.ts` registers
     the mock provider in-process and never reads your `.env`.)
   - Other providers: `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL` for any
     OpenAI-compatible endpoint), `VLLM_BASE_URL` (+ `VLLM_API_KEY`),
     `OLLAMA_BASE_URL` (registered by default at `http://localhost:11434`, so a
     local Ollama roster costs nothing), `HOST_PROXY_URL` (+ `HOST_PROXY_TOKEN`).
   - `ARENA_TRIGGER=always` makes every request a votable matchup and the app's
     Arena-mode toggle becomes cosmetic. With `manual` (what the mock harness
     uses) the toggle sends `x-arena: on` and off-mode serves
     `ARENA_DEFAULT_MODEL`.

4. **Run the app against it**:

   ```bash
   cd integrations/assistant-ui
   OMNIARENA_URL=http://127.0.0.1:3011 npm run dev
   ```

`WEB_ORIGIN` only matters for browser-direct calls; this app proxies
server-side, so it is set above merely for consistency.

## Pinned upstream, and how to bump it

`upstream.json` pins the clone:

- repo: `https://github.com/assistant-ui/assistant-ui.git`
- commit: **`a3bb2e316e037a8ef829a8bcb5b8b4b2034bcc97`** (main, 2026-07-24)
- app: `examples/with-ag-ui`
- package manager: `pnpm@11.10.0`

At that commit the arena rides the example's own workspace dependencies —
`@assistant-ui/react-ag-ui` 0.0.45, `@ag-ui/client` 0.0.57, `next` 16.2.10 — and
this directory pins `@ag-ui/client` 0.0.57 and `@playwright/test` 1.61.1 for the
probe and the tests.

To bump:

```bash
# 1. edit upstream.json: set `commit` (and `packageManager` if upstream moved)
npm run setup            # re-clones/fetches, restores pristine files, re-patches
```

`scripts/setup.mjs` restores every tracked file it patched before re-patching,
and the anchored patches in `scripts/overlay.mjs` **fail loudly** if their exact
upstream text is missing or ambiguous — you get a diff-shaped error naming the
file and the anchor rather than an app that compiles but no longer runs the
arena. The patch targets are `app/MyRuntimeProvider.tsx`, `app/page.tsx`,
`app/globals.css` and `.env.example`; everything else is overlay files that only
ever get copied in.

Useful flags: `npm run setup -- --skip-install` (re-overlay only, when you edited
`overlay/`) and `npm run setup -- --arena-url=http://127.0.0.1:3011` (the
`OMNIARENA_URL` written into the clone's `.env.local`, which is left alone if it
already exists). `git fetch` is skipped on its own when the pinned commit is
already in the clone, so no offline flag is needed.

## Known rough edges

- Next.js prints a workspace-root warning because the clone sits inside the
  OmniArena checkout, which has its own lockfile. It is cosmetic; setting
  `turbopack.root` in the clone traded the warning for Turbopack HMR errors, so
  the patch was dropped.
- The screenshot pass turned up a layout bug in the overlay: `ArenaControls` is a
  flex sibling of upstream's thread root, which is `h-full` inside a `h-dvh`
  parent, so the thread is a full viewport tall *below* the 45px status strip
  and the bottom 45px of the composer hangs off the screen (`document`
  scrollHeight 845 against an 800px viewport). Giving the thread `flex-1
  min-h-0` instead would fix it; that is an upstream-patch change, so it is
  reported rather than quietly applied here.
- Scrolling up puts assistant-ui's "scroll to bottom" button in the flow just
  above the composer, which pushes the composer down another ~37px and — with
  the overflow above — off the bottom edge. Visible in the multi-turn shot.
- An unvoted last turn is only votable after a reload if the client kept the
  `matchupToken` from the original `x-arena-matchup` header — the conversation
  GET never returns tokens (by design). This host persists them in
  `localStorage` for that span.

## Findings about OmniArena

The point of this integration was to test the AG-UI adapter against a real
consumer. What broke, what is missing, and what the wire actually looks like:
**[FINDINGS.md](./FINDINGS.md)**.
