# Setup

Requirements: Docker (Compose v2) for the one-command self-host. For the npm
development path: Node.js 20+, npm, Docker; Python 3.10+ to run the rating
worker outside Docker.

Related: [Architecture](architecture.md) · [API](api.md) · [Integration](integration.md) · [Rating methodology](rating-methodology.md) · [Data model](data-model.md) · [SDK](sdk.md)

## Quick start (Docker, single-tenant self-host)

OmniArena is self-hosted as a **single container per deployment** — one Fastify
process serves both the API and the built web UI on one port, so chat data never
leaves the adopter's infrastructure. `docker compose up`
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
with an SPA fallback that returns `index.html` for any GET route outside the API
prefixes `/api`, `/health`, `/v1`, `/models`, `/chat/completions`, `/completions`,
and `/embeddings` — an unmatched path under one of those gets a JSON 404 instead,
because an OpenAI client that receives `text/html` at 200 for `GET /v1/models`
reports a mimetype error with nothing pointing at the missing route. In the npm
dev path the bundle is absent, so Vite serves the UI on `:5173` and static
serving stays off — the API is unaffected either way. Override the bundle
location with `WEB_DIST_DIR` for non-standard layouts.

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
| `@omni-arena/react` | `packages/react-sdk/` | Published headless React SDK (chat, vote, leaderboard, and analytics hooks plus their framework-free helpers). The demo consumes it. See [SDK](sdk.md). |
| `@omni-arena/web` | `web/` | Vite + React demo; imports `@omni-arena/react` (workspace `*`). |
| `omniarena-rating` | `worker/` | Python rating worker (not an npm workspace). |

`e2e/`, `examples/*`, and `integrations/*` are **not** workspaces either: each has
its own `package.json` and lockfile and is installed on demand by its own script,
so a plain `npm install` at the repo root stays fast and none of them can break
the published build. See [Third-party UI integrations](#third-party-ui-integrations).

## Environment variables

Loaded from the repo-root `.env` regardless of workspace working directory
(`server/src/env.ts`); Docker Compose loads the same `.env` into the containers.
`.env.example` documents every variable the server and the rating worker read;
this table expands on them with bounds and semantics.

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
| `FULL_REFIT_EVERY` | no | `12` | Refits between from-scratch (cold) fits in loop mode; `0` warm-starts indefinitely |
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
| `ARENA_TRIGGER` | no | `always` | When the arena engages: `always` (blind A/B matchup on every request), `manual` (one model unless the request opts in), or `sampled` (engage with probability `ARENA_SAMPLE_RATE`). Any other value fails at boot. See [Trigger and exposure](#trigger-and-exposure). |
| `ARENA_SAMPLE_RATE` | when `ARENA_TRIGGER=sampled` | `0` | Engagement probability in `[0, 1]`. Ignored for `always`/`manual`. Out-of-range values fail at boot. See [Trigger and exposure](#trigger-and-exposure). |
| `ARENA_EXPOSURE` | no | `blind` | What the user sees when engaged: `blind` (both answers streamed, votable) or `shadow` (only the incumbent streamed; challenger persisted silently; not votable). Requires `ARENA_DEFAULT_MODEL` when `shadow`. See [Trigger and exposure](#trigger-and-exposure). |
| `ARENA_DEFAULT_MODEL` | when `ARENA_TRIGGER` is not `always`, or `ARENA_EXPOSURE=shadow` | — | Enabled model served on non-arena (`single`) rounds and as the shadow incumbent: `models.id` UUID, `provider_model_id` slug, `display_name`, or `provider:provider_model_id`. Resolved at boot. See [Trigger and exposure](#trigger-and-exposure). |
| `ARENA_JOIN_WINDOW_MS` | no | `2000` | Rendezvous window for [slot join](architecture.md#slot-join-one-matchup-across-two-requests): how long the first of two sibling requests waits for its pair. `0` disables joining entirely (a `joinKey` is then ignored); max `60000`. |
| `ARENA_JOIN_MAX_PENDING` | no | `256` | Cap on unpaired join scopes held in memory; over the cap a join is refused with `join_unavailable` rather than queued. Min `1`, max `100000`. |
| `ARENA_JOIN_MAX_QUEUED_EVENTS` | no | `4096` | Per-connection event backlog on a joined matchup: how many events may queue for one slot whose client reads slower than the model produces. Over the cap that one connection fails instead of growing without bound. Min `16`, max `1000000`. |

The default seed lineup contains Google models, so the unmodified seed still
needs `GOOGLE_API_KEY`. To use OpenAI, Ollama, vLLM, or host-proxy models, set
their `provider` and `provider_model_id` entries in `server/src/db/seed.ts` and
re-run the seed.

The host-proxy endpoint must expose OpenAI-compatible streaming chat
completions at `<HOST_PROXY_URL>/chat/completions`. OmniArena sends
`model`, the full linear `messages` array, `stream: true`, and the
`x-omni-arena-proxy: 1` header. The host keeps the upstream provider key.

All `ARENA_JOIN_*` values are parsed with coercion and range-checked at boot
(`server/src/arena/join.ts`), so a non-numeric or out-of-range value throws
before the server listens. The Docker Compose `app` service loads the repo-root
`.env` wholesale, so any of these can be set there; the `worker` service instead
forwards each variable the rating worker reads explicitly (see
[Rating worker](#rating-worker)).

## Trigger and exposure

By default **every** request to `POST /api/arena/chat` is a blind A/B matchup.
Two orthogonal axes relax that:

1. **Trigger** (`ARENA_TRIGGER`) — *when* the arena engages.
2. **Exposure** (`ARENA_EXPOSURE`) — *what the user sees* when it does.

| `ARENA_TRIGGER` | What a request gets | Votable |
|---|---|---|
| `always` (default) | an engaged round of two models chosen by the `MATCHMAKER` strategy — the historical behaviour under `blind` | only when `ARENA_EXPOSURE=blind` |
| `manual` | a **`single`** round served by `ARENA_DEFAULT_MODEL`, unless the request opts in; an opted-in request gets an engaged round | only opted-in `blind` rounds |
| `sampled` | an engaged round with probability `ARENA_SAMPLE_RATE`, otherwise a **`single`** round served by `ARENA_DEFAULT_MODEL` | only engaged `blind` rounds |

| `ARENA_EXPOSURE` | Engaged behaviour | Wire `mode` |
|---|---|---|
| `blind` (default) | both answers streamed anonymously; user can vote | `matchup` |
| `shadow` | only the incumbent (`ARENA_DEFAULT_MODEL`) is streamed; a challenger ≠ incumbent runs silently; both responses + a `matchups.mode='shadow'` row are persisted; no vote token | `shadow` |

Resolved plan matrix (`server/src/arena/mode.ts`):

| trigger | engaged? | exposure=`blind` | exposure=`shadow` |
|---|---|---|---|
| `always` | yes | `matchup` | `shadow` |
| `sampled` | hit (`rng < rate`) | `matchup` | `shadow` |
| `sampled` | miss | `single` | `single` |
| `manual` | opted-in | `matchup` | `shadow` |
| `manual` | not | `single` | `single` |

The values are closed enums, so a typo throws before the server listens rather
than silently falling back. `ARENA_SAMPLE_RATE` must parse to a number in
`[0, 1]` (default `0` when unset); out-of-range values also fail at boot.
`ARENA_DEFAULT_MODEL` is required when `ARENA_TRIGGER` is not `always`, or when
`ARENA_EXPOSURE=shadow`.

### How a request opts in

Under `manual`, either signal turns that one request into an engaged round:

- request body `arena: true`
- request header `x-arena: on` — compared case-insensitively, and only `on`
  counts; `1`, `true`, and `yes` do not

The header works on every protocol. The body field rides in each protocol's own
extension slot (AG-UI `forwardedProps`, OpenAI `omni_arena`, top level for
Vercel AI SDK and native SSE) — see [Integration → which protocols accept their
own request body](integration.md#which-protocols-accept-their-own-request-body).
The two signals are OR-ed, so `x-arena: on` opts in even when the body says
`arena: false`. Under `always` both signals are ignored: every request is
engaged regardless.

### `ARENA_DEFAULT_MODEL` accepts a UUID or a human identifier

The value is resolved against the **enabled** roster at boot
(`server/src/server.ts`) and stored as a `models.id` UUID for request handling.
Accepted forms, in preference order:

| Form | Example | Column(s) |
|---|---|---|
| `models.id` | `3f8c9a1e-…` | UUID primary key |
| `provider:provider_model_id` | `google:gemini-3-flash-preview` | unique pair |
| `provider_model_id` (slug) | `gemini-3-flash-preview` | must be unique among enabled models |
| `display_name` | `Gemini 3 Flash` | must be unique among enabled models |

A UUID still works unchanged. Friendly forms remove the need to query Postgres
after seeding (the Open WebUI integration previously worked around this by
looking up an id with `psql`). List the roster any time with:

```bash
curl -s http://localhost:3001/models | jq -r '.data[] | [.id, .name] | @tsv'
```

Validation happens in two places, at two different times:

| When | Check | On failure |
|---|---|---|
| Boot (`server/src/server.ts`) | a non-`always` trigger, or `shadow` exposure, has a non-blank `ARENA_DEFAULT_MODEL` (a whitespace-only value counts as unset) | the process throws (`ARENA_DEFAULT_MODEL is required when ARENA_TRIGGER=<trigger>` or `… when ARENA_EXPOSURE=shadow`) and never listens |
| Boot (`server/src/server.ts`) | the value matches exactly one enabled model (UUID, slug, display name, or `provider:provider_model_id`) | the process throws with the accepted forms and the enabled roster listed, and never listens |
| Each `single` / `shadow` request | the resolved id is still in the **enabled** roster (`listEnabledModels()`) | `default_model_missing`: `ARENA_DEFAULT_MODEL '<uuid>' is not in the enabled roster` |

Boot now resolves and validates the identifier against the current enabled set,
so a mistyped slug or unknown name fails before the server listens. Request-time
membership is still re-checked because the enabled set can change under a
running server (a model disabled after boot still surfaces as
`default_model_missing` on the next `single`/`shadow` request).

### What a `single` round is

One slot, one model, and nothing recorded:

- `mode: "single"`, `slots: ["A"]`, and **`votable: false`** on the round's
  opening metadata, so a client can hide its vote controls.
- **No `matchupToken`, `conversationId`, or `turnIndex`.** These are omitted
  rather than emitted empty, because none of them exists for a round that
  persists nothing — so multi-turn continuation is not available on a `single`
  round either. See [Integration → identifiers you cannot use are not
  sent](integration.md#identifiers-you-cannot-use-are-not-sent).
- **No rating signal at all**, not a weaker one. See [Rating methodology → what
  the engine cannot rate](rating-methodology.md#what-the-engine-cannot-rate).

### What a `shadow` round is

Incumbent on slot A, challenger on slot B, only A on the wire:

- `mode: "shadow"`, `slots: ["A"]`, **`votable: false`**, and **no
  `matchupToken`**. The React SDK already hides vote UI from `votable`.
- Both models run; both responses are persisted on a normal matchup /
  conversation / turn row with `matchups.mode = 'shadow'`.
- `POST /api/arena/vote` rejects shadow matchups with `403 Shadow matchups are
  not votable` — even if a token were somehow presented.
- The challenger is chosen by the existing matchmaker, constrained to differ
  from `ARENA_DEFAULT_MODEL`. Auto-judge pickup of shadow rows is deferred.

### Worked example: `manual` end to end

An app that normally streams one model, with the arena available on demand.

**Step 1 — pick the model to serve on ordinary turns.** Any of these work
against a running, seeded server (or just use a known slug from the seed):

```bash
# Friendly forms — no lookup required once you know the roster:
#   gemini-3-flash-preview
#   google:gemini-3-flash-preview
#   "Gemini 3 Flash"
curl -s http://localhost:3001/models | jq -r '.data[] | [.id, .name] | @tsv'
# 3f8c9a1e-…  Gemini 3 Flash
# b21d47c0-…  Gemini 3.1 Flash-Lite
```

**Step 2 — configure the deployment** in the repo-root `.env` (Docker Compose
loads the same file), then restart the app:

```bash
ARENA_TRIGGER=manual
ARENA_DEFAULT_MODEL=gemini-3-flash-preview   # slug, display_name, provider:id, or UUID
```

**Step 3 — an ordinary request now gets a single, non-votable round:**

```bash
curl -N http://localhost:3001/api/arena/chat \
  -H 'content-type: application/json' \
  -d '{"prompt":"Explain HMAC in two sentences."}'
# matchup_started: {"mode":"single","votable":false,"slots":["A"], …}
#   — no matchupToken, no conversationId, no turnIndex
```

**Step 4 — an opted-in request gets the usual blind matchup**, by header:

```bash
curl -N http://localhost:3001/api/arena/chat \
  -H 'content-type: application/json' -H 'x-arena: on' \
  -d '{"prompt":"Explain HMAC in two sentences."}'
# matchup_started: {"mode":"matchup","votable":true,"slots":["A","B"],"matchupToken":"…", …}
```

…or by body field, which is what a "compare two models" toggle in a UI would
set — on the Vercel AI SDK path that is `useChat({ body: { arena: true } })`:

```bash
curl -N http://localhost:3001/api/arena/chat \
  -H 'content-type: application/json' \
  -d '{"prompt":"Explain HMAC in two sentences.","arena":true}'
```

Only the step 4 rounds are votable, and only they reach the rating worker.

### Worked example: `sampled` end to end

Engage the arena on 5% of traffic; the rest get a single-model round.

```bash
ARENA_TRIGGER=sampled
ARENA_SAMPLE_RATE=0.05
ARENA_DEFAULT_MODEL=gemini-3-flash-preview
```

Each request draws once: `rng < 0.05` → the usual blind matchup; otherwise a
non-votable `single` round from `ARENA_DEFAULT_MODEL`. Opt-in signals
(`arena: true` / `x-arena: on`) are ignored under `sampled` — engagement is
purely probabilistic.

### Worked example: `shadow` end to end

Canary a challenger against a fixed incumbent without showing the user a second
answer:

```bash
ARENA_TRIGGER=always
ARENA_EXPOSURE=shadow
ARENA_DEFAULT_MODEL=gemini-3-flash-preview
```

Every request runs the incumbent as slot A (streamed) and a matchmaker-picked
challenger as slot B (silent). The client sees `mode: "shadow"`, `votable:
false`, `slots: ["A"]`, and no vote token. Both answers land in Postgres with
`matchups.mode = 'shadow'`.

## Database

- **Migrate:** `npm run db:migrate --workspace server` — applies unapplied SQL
  files from `server/src/db/migrations/` in filename order, each in a
  transaction, tracked in `schema_migrations`. To add a migration, create the
  next `NNN_description.sql` file; never edit an applied migration.
- **Seed:** `npm run db:seed --workspace server` — disables **every** existing
  model, then upserts the lineup by `(provider, provider_model_id)` and
  re-enables those rows. Editing `server/src/db/seed.ts` and re-running is
  therefore how you retire a model as well as add one; a model dropped from the
  file stays in the table but leaves the roster. The current lineup is three
  Google models (Gemini 3.1 Flash-Lite, Gemini 3 Flash, Gemini 3.5 Flash).
- **Seed (mock):** `npm run db:seed:mock --workspace server` — disables every
  other model and seeds two `mock`-provider models (`Mock Model Alpha`,
  `Mock Model Beta`). Pair it with `ARENA_MOCK_PROVIDER=1`. See
  [Mock provider](#mock-provider).
- **Seed (demo data):** `npm run db:seed:demo --workspace server` — see
  [Demo data](#demo-data).

## Demo data

Every chart on the [insights dashboard](architecture.md#frontend) is computed
from recorded votes, so a fresh install renders nothing but empty states.
`server/src/db/seed.demo.ts` fabricates a plausible voting record against
whichever models are currently enabled:

It is **opt-in and never runs automatically** — neither the container entrypoint
nor `docker compose up` invokes it, so a fresh deployment starts with a genuinely
empty arena and the dashboard shows its empty states until real votes arrive.

```bash
# npm dev path (host)
npm run db:seed:demo --workspace server
npm run db:seed:demo --workspace server -- --reset --matchups 400 --days 30

# Docker path — run the compiled script directly. `tsx` is a devDependency and
# is pruned from the runtime image, so the npm script is not available there.
docker compose exec app node server/dist/db/seed.demo.js --reset
```

| Flag | Default | Effect |
|---|---|---|
| `--matchups` | `240` | Number of matchups to generate. |
| `--days` | `14` | Window to spread them over, ramping toward the present. |
| `--reset` | off | Delete previously seeded demo data first. |
| `--seed` | `20260724` | PRNG seed; the same value reproduces the same arena. |

Each model's personality is **derived from its name**, so the seeded arena
matches the intuition a reader already has about the roster:

| Name contains | Reads as | Gets |
|---|---|---|
| `lite`, `mini`, `nano`, `small`, `tiny`, `8b`, `haiku` | the fast, cheap variant | lowest latency, terse answers, weakest ratings |
| `pro`, `ultra`, `opus`, `max`, `large`, `70b`, `thinking` | the flagship | slowest, longest answers, strongest ratings |
| a version number | recency | newer versions rate higher; older ones in the same class pad their answers more |
| neither marker, no version | the middle of the roster | mid-tier defaults, ranked by declaration order |

The name matched is `display_name` plus `provider_model_id`, lowercased, and
markers must match a whole name segment, since `gemini` ends in `mini`. With the
default Gemini lineup that yields Gemini 3.5 Flash on top, Gemini 3 Flash second
but padding its answers, and Gemini 3.1 Flash-Lite fastest by a wide margin and
clearly last on quality — so the "does faster win?" scatter has a real answer.

What it generates, and why each part matters:

- **Votes drawn from the same Rao-Kupper model the worker fits**, so the seeded
  record is internally consistent with the rating engine rather than noise.
- **Deliberate style confounding** — verbose, heavily formatted answers win more
  often than their latent strength justifies, so the padded runner-up closes most
  of the raw gap and gives it all back once style is regressed out. Strength is
  weighted above what padding can buy, so the genuinely better model still leads
  the raw leaderboard; style control widens its lead rather than reordering it.
- **Many small anonymous sessions** rather than one large one. The worker's
  [anomaly screen](rating-methodology.md) excludes sessions that look like
  vote-stuffing or a stuck-on-one-side bot, and an excluded session contributes
  nothing to the fit.
- **Backfilled `model_ratings`, `model_style_ratings`, `model_rating_history`,
  and `style_control_coefficients`** so the rating and style charts work before
  the Python worker has ever run. These are a win-rate approximation on the
  worker's Elo-like scale; a real refit overwrites them. The history gets one
  checkpoint per day up to a maximum of twelve, so the rating-over-time chart
  has a line rather than a point.

Demo conversations are tagged with a `demo-` session prefix and `--reset` only
deletes those matchups and conversations, so votes recorded through the real UI
survive re-seeding. The four worker-owned tables are the exception: rows for the
currently enabled models are deleted and rewritten on **every** run, `--reset` or
not. Seeded matchups also carry `harness_version = 'demo'`, which is the easiest
way to tell them apart from real traffic in SQL.

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

# Same loop, but never force a from-scratch refit (default: every 12th):
python -m omniarena_rating --loop --full-refit-every 0

# Skip the pre-fit anomaly screen (keep every session):
python -m omniarena_rating --no-anomaly-filter

# Tests (pure Python, no database):
python -m pytest
```

The pre-fit anomaly screen (`--no-anomaly-filter` to disable) drops spam or
malicious voting sessions via p-value tests before any fit runs.

In loop mode most refits are warm-started from the previous solution, but every
`FULL_REFIT_EVERY` refits (`--full-refit-every`, default `12` — hourly at the
default interval) the worker discards the warm state and fits from scratch, then
cross-checks that a warm-started fit of the same aggregates lands on the same
optimum. `0` disables the forced pass. See
[Rating methodology](rating-methodology.md).

`docker compose up -d` also starts a `worker` service that runs the loop against
the `postgres` service automatically. The image's default command is
`python -m omniarena_rating --loop --style`, so **every refit runs both passes**
and a Docker-only deployment populates `model_ratings`, `model_rating_history`,
`model_style_ratings`, and `style_control_coefficients` with no extra steps.
Ratings appear on the leaderboard after the first successful refit; until then
the rating fields are null. Override the service's `command:` for a one-shot or
default-only run.

The service forwards every variable the worker reads — `REFIT_INTERVAL_SECONDS`,
`FULL_REFIT_EVERY`, `RATING_RIDGE`, `STYLE_RIDGE`, `LOG_LEVEL`, and `LOG_FORMAT`
— from the repo-root `.env`, each defaulting to the worker's own default, plus a
`DATABASE_URL` pointed at the compose `postgres` hostname. Unlike `app` it has no
`env_file`, deliberately: the worker needs no provider keys or app secrets, so
that explicit list is also the whole of what reaches the container.

The worker fits **pairwise** comparisons, so it needs voted matchups to work
with. On a deployment where most rounds are non-votable `single` rounds — which
persist no matchup — there is nothing to aggregate and the rating fields stay
null no matter how often the loop runs. See
[Rating methodology → what the engine cannot
rate](rating-methodology.md#what-the-engine-cannot-rate).

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
  keys needed. Alongside the per-module suites there are two cross-cutting ones:
  `server/src/blindness.test.ts` asserts that no model identity reaches the wire
  in **any** of the five protocols, on a single connection and on both siblings of
  a joined matchup — the cases are generated from the protocol registry, so a new
  adapter is covered by default. `server/src/arena/join.test.ts` covers slot join:
  simultaneous siblings elect exactly one leader, a third claim is refused, the
  pending set stays bounded, and slot B still finishes and is persisted after its
  own consumer disconnects.
- The hook tests moved out of `web/` into the SDK, and now sit beside the
  framework-free modules they cover — `protocol`, `session`, `stream`, `vote`,
  and one file per hook. They run under jsdom and stub `fetch` with real SSE
  `ReadableStream` bodies. `localStorage` is stubbed because Node 24's
  experimental global shadows jsdom's implementation.
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

## Third-party UI integrations

Beyond the purpose-built examples, [`integrations/`](../../integrations/) wires
the arena into **real upstream chat UIs** at pinned revisions. Each directory is
self-contained (its own `package.json`, lockfile, tests, and README) and is not
part of the root workspace, so none of them is installed or built by a plain
`npm install`.

| Directory | Upstream | Protocol | How to run it (from that directory) |
|---|---|---|---|
| [`integrations/vercel-ai-chatbot/`](../../integrations/vercel-ai-chatbot/) | `vercel/ai-chatbot` template | `vercel-ai` | `npm install`, `npm run setup`, `npm test` |
| [`integrations/assistant-ui/`](../../integrations/assistant-ui/) | assistant-ui monorepo, `examples/with-ag-ui` | `ag-ui` | `npm install`, `npm run setup`, `npm test` |
| [`integrations/open-webui/`](../../integrations/open-webui/) | Open WebUI container image (v0.10.2) | `openai` | `npm install`, `docker compose up -d`, `npm run arena` (blocks), then `npm test` |

The two Node ones use the same **pinned clone + overlay** model: `upstream.json`
records the exact upstream commit, `.upstream/` holds the gitignored clone,
`overlay/` holds the arena-layer sources copied in verbatim, and
`scripts/overlay.mjs` applies anchored patches to upstream's own files — each
anchor must match exactly once, so a moved upstream line fails setup loudly
instead of producing a half-integrated app. Open WebUI runs from its published
image instead and reaches the arena through a small OpenAI-compatible bridge
(`bridge/`), with the source checkout used only to verify claims.

All three run key-free against the [mock provider](#mock-provider). See the
[integration guide](integration.md) for what each protocol can and cannot carry.

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
browser through stream → vote → reveal. Both share the expected mock roster and
per-model output fingerprints from `e2e/tests/arena-fixtures.ts`.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on every pull request,
with in-flight runs for the same ref cancelled. **No job needs a secret:** every
suite uses the deterministic mock provider and in-memory `pg-mem`, so CI works
unchanged on forks.

| Job | Steps |
|---|---|
| Node | `npm ci` → `npm run build --workspaces` → `npm run typecheck --workspaces` → the three workspace test suites. Build runs **first** because `web` typechecks against the SDK's emitted declaration files. |
| Python | `pip install -r worker/requirements.txt` → `python -m pytest` in `worker/` |
| End-to-end | `npm ci` at the root and in `e2e/` → `playwright install --with-deps chromium` → `npm run e2e`; Playwright artifacts are uploaded on failure |

CI pins Node `22` and Python `3.11`. Locally the floor is lower — the root
`engines` field asks for Node `>=20` and the worker for Python `>=3.10` — so a
green local run on Node 20 is possible while CI exercises 22. See
[CONTRIBUTING.md](../../CONTRIBUTING.md) for the contribution workflow.
