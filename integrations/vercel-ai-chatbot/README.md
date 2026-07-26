# OmniArena inside the real `vercel/ai-chatbot`

This is the full-fat integration test: the **actual**
[`vercel/ai-chatbot`](https://github.com/vercel/ai-chatbot) template — Vercel's
official Next.js + AI SDK reference chatbot — with OmniArena's blind A/B arena
layer built into it. Not a scaffold that imitates the template (that is
[`examples/vercel-ai-chatbot/`](../../examples/vercel-ai-chatbot/)), but the
upstream repository at a pinned commit, running with its own NextAuth guest
login, Postgres chat history, sidebar, and message list. Every chat is served by
an OmniArena matchup instead of a single model call.

What you get in the UI: two anonymous answers streaming side by side in the
template's own message list, a vote bar (`A is better` / `B is better` /
`Both good` / `Both bad` / `Skip`), model identities revealed after the vote,
the next message continuing the conversation from the winning answer, and a
leaderboard popover in the composer toolbar.

## What it looks like

Every image below is a screenshot of this integration actually running — the
upstream template, its sidebar, its composer, its guest session — captured by
`npm run screenshots` (see [Regenerating the screenshots](#regenerating-the-screenshots)).

Two anonymous answers streaming side by side over one connection, vote controls
already in place but disabled until both finish:

![Two anonymous answers streaming side by side in the vercel/ai-chatbot message list](../../docs/images/integrations/vercel-ai-chatbot/01-streaming.png)

Both answers done. Five ways to vote — `A is better`, `B is better`,
`Both good`, `Both bad`, `Skip` — and still no idea which model wrote which:

![The finished pair with the five-way vote bar enabled and identities still hidden](../../docs/images/integrations/vercel-ai-chatbot/02-vote.png)

The vote lands and the identities appear, with the winner marked and the
continuation rule spelled out:

![After voting: both models named, the winning column marked, identities revealed](../../docs/images/integrations/vercel-ai-chatbot/03-reveal.png)

The follow-up is turn 2 of the same OmniArena conversation, continued from the
answer that won:

![A follow-up question rendered as turn 2 of the same arena conversation](../../docs/images/integrations/vercel-ai-chatbot/04-multi-turn.png)

The trophy in the composer toolbar opens the leaderboard, proxied server-side so
the arena is never exposed to the browser:

![The leaderboard popover listing both models with their win rates and records](../../docs/images/integrations/vercel-ai-chatbot/05-leaderboard.png)

And with `Compare` toggled off against an `ARENA_TRIGGER=manual` arena, the round
degrades gracefully to one column and no vote controls:

![A single, non-votable round: one column and an explanation instead of a vote bar](../../docs/images/integrations/vercel-ai-chatbot/06-single-model.png)

## How it is vendored

The upstream repo is **not** committed here. Instead:

| Piece | Path | Committed? |
|---|---|---|
| Pinned upstream revision | `upstream.json` | yes |
| The clone itself | `.upstream/` | no (gitignored) |
| Arena-layer sources copied into the clone | `overlay/` | yes |
| Anchored edits to upstream's own files | `scripts/overlay.mjs` | yes |
| Setup / run / test orchestration | `scripts/`, `tools/`, `e2e/` | yes |

`scripts/setup.mjs` clones the pinned commit, resets tracked files, copies
`overlay/` in verbatim, then applies the anchored patches in
`scripts/overlay.mjs`. Each patch anchor must match **exactly once**; if the
upstream template moves, setup fails loudly naming the file and the anchor
instead of silently producing a half-integrated app.

Why not a submodule or a fork: a submodule would put a second git repository in
every contributor's checkout for a directory that is throwaway build input, and
a fork would mean carrying 20k stars' worth of code we do not maintain. A pinned
clone plus a small, readable patch list keeps the diff against upstream visible
at a glance — `scripts/overlay.mjs` *is* the integration's documentation.

**Pinned upstream commit:** `c2f8235e1f3ea903ad8b7f61447c4f74164b5c58`
(2026-07-08; Next 16.2.10, `ai` 7.0.15, `@ai-sdk/react` 4.0.16, pnpm 10.32.1).

## Requirements

- Node 20+ and npm (this directory), plus `git`. `pnpm` is fetched on demand via
  `npx` at the version upstream pins — no global install needed.
- A Postgres for the template's own tables. Two options, both covered below:
  Docker (the repo's `docker-compose.yml`) or **no Docker at all** via PGlite.
- **No cloud service is required.** Upstream's Vercel Blob (file uploads),
  Redis (resumable streams), and AI Gateway key are all optional; arena mode
  needs none of them, because the arena route never calls a provider itself.
  Attachments and resumable streams stay unavailable without them.

## 1. Zero-credential automated run (start here)

```bash
cd integrations/vercel-ai-chatbot
npm install
npm run setup          # clone + overlay + patch + pnpm install (a few minutes)
npm test               # the full Playwright suite
```

`npm test` needs no keys, no Docker, and no running services. It starts an
in-process Postgres (PGlite behind a real TCP listener), migrates the template's
schema, runs a production `next build`, boots the real OmniArena Fastify app on
pg-mem with the deterministic mock provider, then drives the app in Chromium:

- two blind answers stream concurrently, vote → identities revealed, follow-up
  lands on turn 2 of the same arena conversation, and the matchup survives a
  page reload (it is persisted as message parts);
- with `Compare` toggled off against an `ARENA_TRIGGER=manual` arena, the round
  comes back as `single`: one column, no vote controls;
- the leaderboard proxy renders both mock models.

## 2. Run it yourself and click through it

You need three things running: a Postgres, the OmniArena server, and this app.

### 2a. Postgres — pick one

**Docker** (reuses the repo's compose Postgres, adds a database for the
template):

```bash
cd integrations/vercel-ai-chatbot
npm run db:up          # docker compose up -d postgres + CREATE DATABASE ai_chatbot
npm run db:migrate
```

**No Docker** (PGlite: Postgres compiled to WASM, speaking the real wire
protocol on a TCP port, data persisted in `.pgdata/`):

```bash
cd integrations/vercel-ai-chatbot
npm run pg             # leave running: postgres://postgres:postgres@127.0.0.1:5433/postgres
```

then point the app at it and migrate, in a second terminal:

```bash
# .upstream/.env.local
POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres
```

```bash
npm run db:migrate
```

PGlite is a single-database, single-backend engine — fine for local use and
tests, not a production Postgres. The TCP shim in `tools/pglite-server.mjs` is
hand-rolled, so it has its own self-test: `npm --prefix tools run verify` proves
both raw `pg` and the template's own Drizzle schema work against it.

### 2b. OmniArena, key-free (mock provider)

From the **repo root**, with a Postgres for the arena itself. Either the compose
one (`docker compose up -d postgres`, the default in `.env`) or the same PGlite
instance as above — the arena's migrations run on PGlite too, and its tables do
not collide with the template's:

```bash
cd ../..                                   # repo root
cp .env.example .env                       # if you have not already
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres  # PGlite path only
export ARENA_MOCK_PROVIDER=1
npm install
npm run db:migrate --workspace server
npm run db:seed:mock --workspace server    # two deterministic mock models
npm run dev --workspace server             # http://localhost:3001
```

> `server/src/env.ts` loads the repo-root `.env` **without** overriding
> variables already in your shell, so the `export`s above win. If you would
> rather edit `.env`, that works too. If `:3001` is busy, start the arena on
> another port (`PORT=3011`) and set `OMNIARENA_URL=http://localhost:3011` in
> `.upstream/.env.local` to match.

### 2c. The app

```bash
cd integrations/vercel-ai-chatbot
npm run dev            # http://localhost:3000
```

Open http://localhost:3000. The template signs you in as a guest
automatically. Then:

1. Type a prompt and send. Two columns labelled **MODEL A** and **MODEL B**
   stream at once, over a single connection, with the identities hidden.
2. Click one of the five vote buttons. The vote is recorded and both names are
   revealed, with the winner marked.
3. Send a follow-up. It continues the arena conversation from the winning
   answer (the header shows `turn 2`).
4. Click the trophy in the composer toolbar for the leaderboard.
5. Reload the page — the matchup, both answers, and the reveal come back from
   the database.

The `Compare: on/off` button next to it is the per-request opt-in a
`ARENA_TRIGGER=manual` deployment reads. Against the default
`ARENA_TRIGGER=always` arena, every message is a matchup either way.

Upstream's model picker is replaced in the toolbar by a static **Models chosen by
the arena** label: OmniArena's chat API takes no model hint, so the roster is
whatever the arena has enabled — and a named model beside a blind matchup would
read as the model answering you, which is the tell a pre-vote screen cannot
afford.

## 3. Point it at real models with real keys

Nothing in this app needs a provider key — the arena owns the model calls. So
switching to real models is entirely a change on the **OmniArena side**, at the
repo root:

1. Put the keys in the root `.env` (see [`.env.example`](../../.env.example) and
   `server/src/providers/configure.ts`):
   - `GOOGLE_API_KEY` — the default seed lineup is Gemini
     ([get a key](https://aistudio.google.com/apikey))
   - `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`) for OpenAI-compatible
     endpoints, `OLLAMA_BASE_URL` for local Ollama, `VLLM_BASE_URL` /
     `VLLM_API_KEY` for vLLM, `HOST_PROXY_URL` / `HOST_PROXY_TOKEN` to keep the
     provider key on your own proxy
   - `MATCHUP_TOKEN_SECRET` — any string ≥16 chars
2. Seed the real lineup and **stop using the mock provider**:

```bash
# repo root, with ARENA_MOCK_PROVIDER unset
npm run db:seed --workspace server   # models from server/src/db/seed.ts
npm run dev --workspace server
```

`db:seed:mock` disables every non-mock model, so if you ran it earlier, re-run
`db:seed` — it re-enables the real lineup. Edit `server/src/db/seed.ts` to
choose which models compete (provider + `provider_model_id` per row).

Nothing about the app changes: keep `npm run dev` in this directory. The only
env var it cares about is `OMNIARENA_URL` in `.upstream/.env.local` (default
`http://localhost:3001`).

Optional arena settings worth knowing:

| Variable (root `.env`) | Effect here |
|---|---|
| `ARENA_TRIGGER=always` (default) | every request is a matchup; the `Compare` toggle is a no-op |
| `ARENA_TRIGGER=manual` | `Compare: on` → matchup; `Compare: off` → one model, no vote UI |
| `ARENA_DEFAULT_MODEL` | required with `manual`: the **database uuid** of the model to serve single rounds (`select id, display_name from models`) |
| `MATCHMAKER=smart\|random` | how the pair is chosen |

## Regenerating the screenshots

```bash
cd integrations/vercel-ai-chatbot
npm run screenshots
```

Same zero-credential stack as `npm test` — PGlite for the template's Postgres,
a real OmniArena Fastify app for the arena, the vendored template in dev mode —
driven by Playwright at a 1280×800 viewport with `deviceScaleFactor: 2`, forced
light mode, and Next's dev overlay hidden. The six PNGs are written to
[`docs/images/integrations/vercel-ai-chatbot/`](../../docs/images/integrations/vercel-ai-chatbot/)
and re-encoded as palette PNGs (`scripts/optimize-pngs.mjs`) so each stays well
under 100 KB. Ports are taken from the ephemeral range at startup, so a run
never collides with a dev server you already have on `:3000`/`:3001`.

| File | Role |
|---|---|
| `e2e/screenshots/capture.spec.ts` | The shot list: what to send, what to wait for, when to press the shutter |
| `e2e/screenshots.config.ts` | Viewport, colour scheme, and the two web servers |
| `e2e/harness/arena-demo.ts` | The OmniArena instance behind the images |
| `scripts/screenshots.mjs` | Postgres + migrate + Playwright + PNG optimisation |

`arena-demo.ts` is the e2e harness with one deliberate difference: its stub
provider streams a few sentences word by word at reading speed instead of the
one-line canned reply in `server/src/providers/mock.ts`. That is what makes a
genuine mid-stream frame photographable at all, and it gives the two columns
visibly different answers so the blind comparison reads as a comparison. No
provider is contacted and no key is used, which is why the models in the images
are still called *Mock Model Alpha* and *Mock Model Beta*.

## How the integration works

Request path for one arena turn:

```
useChat (upstream)
  └─ POST /api/arena/chat                     overlay/app/(chat)/api/arena/chat/route.ts
       ├─ auth() + saveChat/saveMessages       (the template's own session + tables)
       └─ POST OmniArena /api/arena/chat?protocol=vercel-ai
            └─ UI Message Stream (SSE) ── teed ──▶ browser
                                          └────▶ accumulated, then persisted
```

| File (under `overlay/`) | Role |
|---|---|
| `app/(chat)/api/arena/chat/route.ts` | The arena replacement for upstream's `/api/chat`: same auth and persistence, no provider call, no LLM title generation |
| `app/(chat)/api/arena/vote/route.ts` | Proxies the vote, receives `continuable`/`conversationId`, then appends the reveal to the stored assistant message so it survives a reload |
| `app/(chat)/api/arena/leaderboard/route.ts` | Server-side leaderboard proxy, so the arena never has to be exposed to the browser or CORS-configured |
| `app/(chat)/api/arena/matchups/[id]/route.ts` | Server-side proxy for reading round details (`GET /api/arena/matchups/:id`) out-of-band |
| `app/(chat)/api/arena/conversations/[id]/route.ts` | Server-side proxy for thread rehydration (`GET /api/arena/conversations/:id`) |
| `lib/arena/stream.ts` | Tees the SSE stream: forwards every frame untouched, accumulates slot A/B text, and injects the message id into the `start` frame so the streamed and stored messages are the same entity |
| `lib/arena/protocol.ts` | Shared types plus `readArenaMatchup`, which reconstructs a matchup from a message's parts (live or replayed from Postgres) |
| `components/arena/arena-provider.tsx` | Client state: the toggle, server-stated continuation (`continuable`/`conversationId`), per-matchup vote state, and out-of-band matchup hydration |
| `components/arena/arena-matchup.tsx` | The two blind columns, mode/turn labels, reveal chips |
| `components/arena/arena-vote-bar.tsx` | The five vote buttons; hidden when the round is not `votable` |
| `components/arena/arena-controls.tsx` | Composer toolbar: `Compare` toggle, leaderboard popover, and the label that replaces upstream's model picker |

Slot B is the interesting part. The AI SDK's UI Message Stream describes **one**
assistant message, so OmniArena's `vercel-ai` adapter puts slot A on the normal
text channel and multiplexes slot B through custom `data-arena-b-delta` parts.
The client reads both from the same `useChat` message; nothing about upstream's
transport or state management is replaced.

`@omni-arena/react`'s `useArenaChat` is **not** used here, on purpose — the
template's `useChat` owns message state. Its primitive layer now covers most of
what `overlay/lib/arena/` hand-rolls; see the findings below.

## Updating the pinned upstream commit

1. Edit `commit` (and the version note) in `upstream.json`.
2. `npm run setup` — patch anchors that no longer match fail with the file, the
   anchor text, and why the patch exists.
3. Fix those anchors in `scripts/overlay.mjs`, then `npm test`.

The template tracks AI SDK releases closely, so treat a bump as a real change,
not a chore.

## Findings from building this

Honest notes on what the integration exposed. The friction is in OmniArena, not
in the template.

- **`useArenaChat` cannot be used in an AI SDK app** — and that finding has since
  been answered. The hook owns its own `fetch`, its own slot state, and speaks the
  native SSE protocol from the browser; in this app `useChat` owns message state
  and the app proxies the arena server-side for auth and persistence, so adopting
  it would mean two competing state machines and a bypassed session. What has
  changed is that `@omni-arena/react` no longer *is* that hook: it now also ships
  a React-free primitive layer — `parseArenaMatchup` / `parseArenaReveal` /
  `parseArenaSlotError`, `getSessionId`, `submitArenaVote`, `useArenaVote`, and the
  wire types — which is close to a drop-in replacement for `overlay/lib/arena/`'s
  hand-rolled equivalents, including in a server route. The overlay has not been
  rewritten onto it (`lib/arena/protocol.ts` still parses parts itself), so this
  stands as a follow-up rather than as a gap in the SDK.
- **Single (non-votable) rounds hand out a `conversationId` that does not
  exist.** `server/src/routes/chat.ts` returned a fresh uuid for `single` plans
  but persisted no matchup, so sending it back yielded `404 Conversation not
  found`. This client only continues after a decisive vote, so it never tripped —
  but the field looked usable and was not. **Fixed:** the `single` path now emits
  `matchup_started` with `matchupId`, `mode` and `votable` only, and the
  `data-arena-meta` part carries no `conversationId` or `turnIndex` at all.
- **`matchupToken: ""` as the "no token" sentinel** on single rounds forced
  clients to treat an empty string as meaningful. **Fixed:** `matchupToken` is
  optional on the wire and simply absent when there is no token, so the empty
  string never appears; the overlay's `readMeta` still filters `""` so it keeps
  working against a server that predates the change.
- **`ARENA_DEFAULT_MODEL` is a database uuid.** An operator has to query
  Postgres to configure it, and a wrong value fails at request time with a 500
  rather than at boot. A slug or `provider:provider_model_id` would be kinder.
- **The `vercel-ai` adapter always advertises `dataSlot: "B"`**, even on a
  `single` round where nothing will ever arrive on it; `mode`/`votable` are what
  actually tell you.
- **Nothing in the wire protocol identifies the app's message.** The adapter's
  `start` frame carries no `messageId`, so a persisting host must rewrite it
  (`lib/arena/stream.ts`) or store a message the live UI cannot reach. An
  optional client-supplied id would remove that transform.
- **Vote reveal is not replayable.** `POST /api/arena/vote` returns the
  identities once; there is no `GET` for "who was in matchup X". Every host app
  has to store the reveal itself to survive a reload, as this one does.
