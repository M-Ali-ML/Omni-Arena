# Architecture

OmniArena is a small, self-hosted service for blind, multi-turn side-by-side LLM
comparisons. This document describes the architecture **as implemented today**.

Related: [API](api.md) · [Integration](integration.md) · [Rating methodology](rating-methodology.md) · [Data model](data-model.md) · [Setup](setup.md) · [SDK](sdk.md)

## System overview

The repo is an npm workspace monorepo with four packages, plus two directories of
non-workspace consumer code (`examples/`, `integrations/`) and the `e2e/` harness:

| Package | Path | Role |
|---|---|---|
| `@omni-arena/server` | `server/` | Fastify API: matchmaking, dual-model streaming through the protocol-adapter layer, WebSocket control plane, slot join, voting, leaderboard, analytics |
| `@omni-arena/react` | `packages/react-sdk/` | Published headless React SDK: hooks plus the framework-free protocol/stream/vote/session modules they are built from; the demo consumes it. See [SDK](sdk.md) |
| `@omni-arena/web` | `web/` | Vite + React demo UI; the reference consumer of `@omni-arena/react` |
| `omniarena-rating` | `worker/` | Python Bradley-Terry rating worker (NumPy/SciPy) |

```
[ web (React demo) ] ── imports ──▶ [ @omni-arena/react (SDK hooks + helpers) ]
   │ useArenaChat / useArenaVote / useArenaLeaderboard / useArena*Analytics
   │ (Vite dev proxy → :3001)
   ▼
[ server (Fastify) ]
   ├─ routes/chat        POST /api/arena/chat   → EventAdapter (5 wire protocols)
   │                     also POST /chat/completions and /v1/chat/completions
   ├─ routes/models      GET  /models and /v1/models (OpenAI-compatible roster)
   ├─ routes/control     GET  /api/arena/control (WebSocket: stop / steer-stub)
   ├─ routes/vote        POST /api/arena/vote   → reveal identities
   ├─ routes/leaderboard GET  /api/arena/leaderboard  (win-rate + ratings + context)
   ├─ routes/analytics   GET  /api/arena/analytics/*  (summary / head-to-head /
   │                     model-metrics / activity / style-control / rating-history)
   ├─ ArenaCore          fan-out to two providers, one event stream (AbortSignal)
   ├─ adapters/          selectProtocol → SSE (default) / AG-UI / A2UI / Vercel / OpenAI
   │                     egress EventAdapter + ingress RequestAdapter
   ├─ JoinBroker         pairs two sibling requests into one matchup (opt-in joinKey)
   ├─ MatchupRegistry    AbortController per in-flight matchup (control plane)
   ├─ SmartMatchmaker    prioritizes under-sampled / high-variance pairs
   │                     (RandomMatchmaker still available; MATCHMAKER=random)
   ├─ MatchupTokenService HMAC-signed matchup tokens
   ├─ provider adapters   Google / OpenAI / Ollama / vLLM / host proxy / mock
   └─ PostgresRepository conversations / turns / matchups / responses / preferences
                         + leaderboard and analytics aggregations
              │
              ▼
        [ PostgreSQL ] ◀── model_ratings + model_style_ratings ── [ worker (Python) ]
              │              + model_rating_history (append-only)   BT + tie model, Fisher CIs,
              ▼                                                     anomaly screen, style control
     [ configured model endpoints ]                                 (periodic batch refit)
```

The rating worker runs **off the hot path**: the request/stream/vote loop never
waits on it. It periodically screens anomalous voting sessions, aggregates votes
in-database, refits ratings, and upserts a `model_ratings` snapshot the
leaderboard reads via LEFT JOIN — appending the same rows to
`model_rating_history` in the same transaction, so rating-over-time charts have
a trail. A heavier periodic pass fits style-controlled ratings into
`model_style_ratings`.

## Distribution topology (single container)

OmniArena is self-hosted as a **single container per deployment**: one Fastify
process serves both the JSON/streaming API and the built web UI on one port
(`PORT`, default 3001), same-origin. Static serving activates only when the
`web/dist` bundle exists (production/Docker) via `@fastify/static`, with an SPA
fallback that returns `index.html` for any GET route outside the API prefixes
`/api`, `/health`, `/v1`, `/models`, `/chat/completions`, `/completions`, and
`/embeddings`. That list matters because the OpenAI-compatible surface lives at
top-level paths: without it an unmatched `GET /v1/models` would answer `text/html`
at 200 and an OpenAI client would report a mimetype error rather than a missing
route. `WEB_DIST_DIR` overrides the bundle path. In the npm dev path the bundle is
absent, so Vite serves the UI on `:5173` and the API stays on `:3001`.
`docker compose up` brings up Postgres, the rating worker, and the app, whose
entrypoint runs migrate → seed → start. See [Setup](setup.md).

## Hexagonal boundaries (ports)

Even in the MVP, the core is separated from its edges by small interfaces in
`server/src/core/ports.ts`:

| Port | MVP implementation | Future replacement |
|---|---|---|
| `ModelProviderPort` | Google, OpenAI-compatible, Ollama, and host-proxy implementations | additional providers |
| `ProviderResolverPort` | `ProviderRegistry` (name → provider) | unchanged |
| `MatchmakingPort` | `SmartMatchmaker` (default) / `RandomMatchmaker` (fallback) | King-of-the-Hill / bandit variants |
| `MatchmakingStatsPort` | `PostgresRepository` (pair game counts + rating-interval widths) | unchanged |
| `PreferenceRepositoryPort` | `PostgresRepository` | unchanged |
| `LeaderboardPort` | win-rate SQL + `model_ratings` + `model_style_ratings` LEFT JOINs in `PostgresRepository`, plus `getRatingContext()` for component connectivity and the fitted style coefficients | more surfaced rating variants |
| `AnalyticsPort` | summary / head-to-head / model-metrics / activity / style-control / rating-history aggregations in `PostgresRepository` (percentiles and time-bucketing computed in TypeScript to stay pg-mem-testable) | prompt-category scoping |
| `EventAdapter` (egress port) | native SSE (default) + AG-UI, A2UI, Vercel AI SDK, OpenAI SSE, chosen by `selectProtocol` | more wire protocols |
| `RequestAdapter` (ingress port) | AG-UI, OpenAI, and Vercel AI SDK request envelopes; native SSE and A2UI have none and accept only OmniArena's own body | more envelopes |

Tests inject in-memory implementations behind the same ports.

## Stream orchestration

`ArenaCore.stream()` (`server/src/core/arena.ts`) fires both provider calls
concurrently and merges their tokens into one async event stream via an
internal async queue. Internal events (`server/src/core/events.ts`):

- `token` — one token for slot `A` or `B`
- `slot_error` — a slot failed; the other slot keeps streaming (fault isolation)
- `slot_done` — full content + latency for one slot (internal only; the public
  variant strips content and metrics so identities can't be inferred)
- `matchup_done` — both slots finished

The chat route converts internal events to public events with `toPublicEvent()`,
persists each `slot_done` as a `responses` row, and hands the public event to the
selected protocol adapter for framing. Internal completion events include TTFT,
stream duration, token count/source, Markdown density, and provider-reported
model version. Each matchup stores the configured `HARNESS_VERSION`.

## Egress: the protocol-adapter layer

There is exactly one internal event stream. Every event an adapter is allowed to
emit is described by the zod `publicArenaEventSchema` in
`server/src/core/events.ts` (`matchup_started`, `token`, `slot_error`,
`slot_done`, `run_error`, `matchup_done`). That single stream is fanned out to
**five wire protocols** through a small egress port, so the chat route never
knows any framing details.

- **`EventAdapter` port** (`server/src/adapters/event-adapter.ts`) — three
  members: `headers` (response headers the protocol needs before the first
  chunk), `serialize(event)` (wire-ready bytes for one schema-validated event),
  and `finalize()` (trailing bytes before close, e.g. a `[DONE]` sentinel), plus
  an optional `inBandErrors` flag for a protocol whose clients settle a run on a
  terminal error *event* and treat a non-2xx as a dead transport (AG-UI): the
  route then delivers a pre-stream failure as a `run_error` at 200 instead of an
  HTTP status.
- **`RequestAdapter` port** (`server/src/adapters/request-adapter.ts`) — the
  ingress half, implemented by the three protocols that have a canonical client
  request envelope (AG-UI's `RunAgentInput`, OpenAI's `/chat/completions` body,
  the AI SDK's `useChat` body). Two members: `claims(body)` — is this the
  protocol's own envelope rather than OmniArena's? — and `parse(body)`, which
  translates it into the one internal `ArenaChatRequest` the route runs on. So a
  stock client of those protocols needs no transport in front of the endpoint, and
  the route keeps a single code path. Detection is structural (a `messages` array
  and no `prompt`), so OmniArena's own body is unchanged on every protocol — see
  [Integration → request bodies](integration.md#which-protocols-accept-their-own-request-body).
- **Adapters** — `sse.ts` (native, default), `ag-ui.ts`, `a2ui.ts`,
  `vercel-ai.ts`, `openai-sse.ts`. Each validates against
  `publicArenaEventSchema` at the boundary before framing, so a malformed chunk
  fails loudly instead of reaching a client; the three with a request envelope
  validate that against their own zod schema at the same boundary.
- **Slot failures on text-only protocols** (`server/src/adapters/slot-error.ts`)
  — AG-UI and OpenAI have no per-message error taxonomy, only assistant text, so
  a `slot_error` is carried twice there: structurally (AG-UI's `CUSTOM
  slot_error`, the OpenAI adapter's `omni_arena_error` extension) for clients that
  read it, and as text prefixed with the shared `[omni-arena:slot-error]` marker
  so a client that only renders content shows something instead of a permanently
  blank column. The marker is what keeps that text distinguishable from the model
  having said those words.
- **`selectProtocol(protocol, accept)`** (`server/src/adapters/registry.ts`) —
  resolves both halves from one decision: the `?protocol=` query param, then the
  `Accept` header media type, then the default. An unknown value falls back to
  native SSE, which is preserved **byte-for-byte**, so the demo, the SDK, and any
  existing client are unaffected. The OpenAI protocol is additionally implied by
  the `/chat/completions` and `/v1/chat/completions` paths, which a client
  configured with a base URL reaches on its own.

- **Roster discovery** (`server/src/routes/models.ts`) — `GET /models` and
  `GET /v1/models` return the enabled roster in OpenAI's `{object: "list", data}`
  shape (both paths, because a deployment may be configured with or without the
  `/v1` prefix). It is part of the adapter surface rather than an extra: an OpenAI
  client's *first* call is the model list — Open WebUI treats it as the connection
  check and builds its picker from it — so without it the OpenAI adapter is
  undiscoverable however well-formed its stream is. The roster is not secret (the
  leaderboard already names every model); what stays blind is which two models a
  given matchup drew.

See [API → Protocol selection](api.md) for the aliases, media types, and
per-protocol framing. The key invariant: internal event **semantics are
identical across protocols**; only the framing differs.

## WebSocket control plane

`GET /api/arena/control` (`server/src/routes/control.ts`, registered via
`@fastify/websocket` in `server/src/app.ts`) is a bidirectional channel that
acts on an in-flight matchup out-of-band from the token stream.

- **`MatchupRegistry`** (`server/src/control/registry.ts`) hands out one
  `AbortController` per matchup. The chat route `register`s the controller when
  it starts streaming and `release`s it in a `finally` when the stream ends.
- The controller's `AbortSignal` is threaded through
  `ArenaCore.stream(messages, assignment, signal?)`: aborting closes the internal
  queue so the route stops emitting immediately, and in-flight producers observe
  `signal.aborted` and break out of their provider stream on the next chunk.
- **`stop`** works today: the control plane looks a matchup up by id and aborts
  it, replying `{ ok: true }` (or `ok: false` for an unknown/finished matchup).
- **`steer`** is a **schema-validated, documented stub**: it returns a negative
  ack (`accepted: false`) so the wire contract and seam exist, but the
  instruction is not yet wired into the running producers.

## Slot join: one matchup across two requests

The default shape puts both slots on one connection. Real compare-view chat UIs
don't do that: they fan a multi-model turn out into **one request per model**
sharing a conversation identifier (Open WebUI v0.10 is the measured case, see
`integrations/open-webui/`). Each of those requests has exactly one answer
channel, so interleaving both slots on it either garbles the two answers together
or produces two unrelated matchups and two half-votes.

Slot join (`server/src/arena/join.ts`) fixes that server-side. A client opts in by
sending `joinKey` on `POST /api/arena/chat`; two requests that resolve to the same
scope inside a short window become **one** matchup, each streaming its own slot
over its own connection, with one `matchups` row and one vote.

| Piece | Role |
|---|---|
| `JoinBroker.claim(scope)` | Assigns roles. First arrival is the **leader** (slot A), the sibling is the **follower** (slot B). Fully synchronous — no `await` between deriving the scope key and recording the claim — so on Node's single-threaded loop two simultaneous siblings can never both win, whatever order they are dispatched in. |
| `JoinScope` | What a join is authorized by: the HMAC of `{sessionId, conversationId, prompt, joinKey}` under a per-process random secret. The `joinKey` alone is only a correlation ID the client already has, so it is deliberately *not* the capability; the tuple is strictly stronger than the session ID that already gates conversation access, and the key never leaves the process. |
| `JoinedRound` | The single shared generation, demultiplexed into one `SlotChannel` per slot. The **leader owns the pump and all persistence** and keeps consuming even if its own client disconnects, so slot B still finishes and is recorded. |
| `SlotChannel` | Single-producer/single-consumer queue drained by one HTTP response. Aborting one connection ends only that connection. Each side gets `matchup_done` as soon as *its* slot finishes rather than waiting for the other. The backlog is capped at `ARENA_JOIN_MAX_QUEUED_EVENTS` (default 4096), after which that slot fails rather than growing without bound. |
| `JoinHandshake` | What the leader publishes to the follower once the matchup exists: `matchupId`, `matchupToken`, `conversationId`, `turnIndex`. |

Everything that could duplicate arena semantics happens **only** on the leader's
path — reading the conversation, the matchmaker, the token, the `matchups` insert
— and the follower mirrors slot B. Each connection announces only its own slot in
`matchup_started` (`slots: ["A"]` / `["B"]`), and the leader's control-plane
`AbortController` cascades onto the shared generation, so one `stop` stops both.

Failure modes are explicit rather than silent, because a client that thinks it
joined but didn't would show one answer and cast a meaningless vote:

| Condition | Status / code |
|---|---|
| `joinKey` without a `sessionId` | `400 join_requires_session` |
| Both slots of the scope already claimed | `409 join_slots_exhausted` |
| Sibling arrives after the window closed | `409 join_expired` |
| More than `ARENA_JOIN_MAX_PENDING` unpaired scopes | `503 join_unavailable` |
| Leader never publishes (window + 30 s) | `504 join_leader_timeout` |
| Pre-stream failure on the leader | The leader's own status/code, forwarded verbatim so both siblings report the same thing (`500 join_failed` when it is unclassified) |

A window that closes with no sibling is **not** an error: the round degrades to
exactly the default shape — both slots on the leader's connection, votable,
nothing wasted. `ARENA_JOIN_WINDOW_MS=0` disables joining entirely and a
`joinKey` is then ignored. See [Setup → environment variables](setup.md) for the
two knobs and their bounds.

## Multi-turn linear history

`matchup_started` returns a `conversationId` and zero-based `turnIndex`. A
follow-up sends that conversation ID; the repository reconstructs context from
stored prompts and decisive votes. Every prior assistant message is the
`left`/`right` winner only—client-provided history is never trusted.

The `turns.parent_response_id` and `(conversation_id, turn_index)` uniqueness
constraints prevent concurrent requests from branching the history. Ties,
both-bad votes, skips, and unvoted turns cannot be continued. Conversation
ownership is checked against the anonymous session ID.

## Provider and key-custody modes

- Direct: `GoogleModelProvider`, `OpenAICompatibleModelProvider`, and
  `OllamaModelProvider`. The OpenAI-compatible implementation is also
  registered as `vllm` when configured.
- Host custody: `HostProxyModelProvider` calls an OpenAI-compatible endpoint
  owned by the host. OmniArena receives only an optional proxy token, never the
  upstream provider credential.
- Mock: `MockModelProvider` (`server/src/providers/mock.ts`) is a deterministic,
  network-free stub for demos, the reference examples, and CI/e2e. It is
  registered only when `ARENA_MOCK_PROVIDER=1`, so it never shadows a real
  provider in production. See [Setup → Mock provider](setup.md).
- All providers receive the same typed `ChatMessage[]` and emit normalized
  token/metadata chunks.

Prompts and responses are persisted as received; OmniArena does not transform or
redact stored content.

## Blind voting integrity

- Model identities are never sent before a vote. `matchup_started` carries only
  slot IDs and a matchup token.
- The matchup token is HMAC-SHA256 signed (`server/src/token.ts`), contains
  `matchupId`, both slot model IDs, an optional session ID, and a 15-minute
  expiry. Only its SHA-256 hash is stored in the database.
- Voting verifies signature, expiry, claims-vs-database consistency, and the
  stored hash; a unique constraint enforces one vote per matchup.
- The invariant is asserted as a property rather than per-adapter:
  `server/src/blindness.test.ts` generates its cases from the protocol registry and
  checks that no model identity reaches the wire in **any** protocol, on a single
  connection and on both siblings of a [joined](#slot-join-one-matchup-across-two-requests)
  matchup — so a newly added adapter is covered without a new test.

## Bradley-Terry rating worker

The `worker/` package (`omniarena_rating`) computes the style-agnostic default
leaderboard rating. It is a separate Python process (NumPy/SciPy), not part of
the Fastify request path, and follows a strict *aggregate-then-compute* design.

Its only input is recorded **comparisons** — `preferences ⋈ matchups`. A
non-votable `single` round persists neither, so it never reaches the worker, and
a deployment that mostly serves such rounds has nothing to rate. See
[Rating methodology → what the engine cannot
rate](rating-methodology.md#what-the-engine-cannot-rate).

| Step | Module | What it does |
|---|---|---|
| Anomaly screen | `anomaly.py` | Runs **before** aggregation: p-value tests over anonymous sessions flag spam/malicious voters, whose votes are excluded from the fit. See [Anomaly detection](#anomaly-detection). |
| Aggregate | `aggregate.py` | One SQL `GROUP BY` collapses `preferences` ⋈ `matchups` into canonical `(model_lo, model_hi, wins_lo, wins_hi, ties)` triples. `skip` and flagged sessions excluded. O(votes) → O(model pairs); raw rows never leave Postgres. |
| Fit | `bradley_terry.py` | Log-parameterized BT (`r_i = log θ_i`) MLE via SciPy **L-BFGS-B** with an analytic gradient. **Rao-Kupper** tie modeling (symmetric ordered logit, threshold `±η`). Weak **ridge prior** for identifiability + regularization. **Sum-to-zero anchoring**. **Warm-start** for incremental refits. |
| Intervals | `confidence.py` | Primary CIs from the **inverse Hessian** (observed Fisher information / Laplace approximation), projected through the anchoring contrast. A **multinomial bootstrap** over the aggregated triples validates them. |
| Connectivity | `connectivity.py` | Union-find over the comparison graph; ratings only comparable within a connected component. Isolated models get their own component id and wide intervals. |
| Style control | `style.py` | Heavier **periodic pass** on raw votes: joint style-controlled BT regression. See [Style-controlled ratings](#style-controlled-ratings). |
| Write back | `writeback.py` | Idempotent upsert into `model_ratings` (default) and `model_style_ratings` + `style_control_coefficients` (style pass). |

Ratings are reported on an Elo-like display scale
`display = 1000 + (400/ln 10)·r`, centered per connected component. See the
[rating methodology](#rating-methodology) summary below, or the dedicated
[rating methodology](rating-methodology.md) doc for the full statistical story.

The worker runs one-shot (`python -m omniarena_rating`) or as a periodic loop
(`--loop`); the Docker Compose `worker` service runs the loop. Loop refits are
warm-started, except that every `FULL_REFIT_EVERY` refits (default 12) the warm
state is discarded for a from-scratch ground-truth fit, which also cross-checks
the warm path for drift. Only `both_good`/`both_bad` count as ties; `skip` votes
are dropped.

The compose `worker` service runs **both passes**: its image `CMD` is
`--loop --style`, so a stock `docker compose up` keeps `model_style_ratings` and
`style_control_coefficients` current alongside `model_ratings`, and the
dashboard's style panels have data from the first refit onward. See
[Setup → rating worker](setup.md#rating-worker).

### Rating methodology

For models $a$, $b$ with log-ratings $r_a$, $r_b$ and $d = r_a - r_b$, the
Rao-Kupper model gives $P(a \succ b) = \sigma(d - \eta)$,
$P(b \succ a) = \sigma(-d - \eta)$, and $P(\text{tie}) = \sigma(d+\eta) -
\sigma(d-\eta)$, where $\eta \ge 0$ is a fitted tie threshold. The worker
maximizes the ridge-penalized log-likelihood (a Gaussian prior on ratings),
which is convex, so L-BFGS-B converges quickly with no learning-rate tuning.
The ridge does three jobs at once: it identifies the otherwise
additive-constant-free ratings, regularizes sparsely-compared models toward the
population mean, and keeps the Hessian invertible so the Fisher-information
covariance exists. Standard errors are projected through the sum-to-zero
contrast so they describe the identified ratings, and the multinomial bootstrap
independently confirms them.

### Style-controlled ratings

Human voters reward superficial traits — longer answers, heavier markdown,
faster first tokens, and the left-hand slot — that inflate a model's apparent
strength. Following the LMSYS approach, `style.py` folds these confounders into
the **same** Bradley-Terry logistic regression as extra covariates rather than a
separate post-hoc pass, so strengths and style coefficients are estimated
jointly. For a vote on a matchup with slot-A model $a$ and slot-B model $b$:

$$d = (r_a - r_b) + \beta \cdot x, \quad P(A \succ B) = \sigma(d - \eta)$$

The per-vote style delta $x$ (slot A minus slot B) has five terms:
**position** (a constant 1.0, so its coefficient is exactly the systematic
left-slot advantage), **verbosity** (`output_token_count` delta),
**formatting** (`markdown_density` delta), and **latency** (`ttft_ms` and
`stream_duration_ms` deltas). Ties reuse the same Rao-Kupper threshold $\eta$; a
small ridge penalty on all coefficients keeps the joint fit stable when the
covariates correlate.

Because the deltas vary per vote, this fit **cannot** use the O(model pairs)
aggregation — it runs on raw vote rows joined across `preferences` ⋈ `matchups`
⋈ `responses`, so it is a heavier, less frequent pass (`--style`) kept separate
from the fast default path. Results land in `model_style_ratings` (rating + CI,
per connected component) and the fitted coefficients in
`style_control_coefficients`. The leaderboard exposes them as
`styleControlledRating`.

### Anomaly detection

`anomaly.py` screens anonymous voting sessions **before** any fit, using
`preferences.anonymous_session_id`. Each session runs three p-value tests, and
any rejection (Bonferroni-adjusted at $\alpha/3$) excludes the session:

- **Volume** — a Poisson upper-tail test `P(X ≥ n)` against the mean votes per
  session flags vote-stuffing.
- **Position bias** — a two-sided binomial test of the decisive left/right split
  against $p = 0.5$ (slots are randomized) flags always-left/always-right bots.
- **Speed** — when timestamps exist, a session whose median inter-vote gap is
  below a floor (default 1.5s) is too fast to be human.

Excluded sessions are dropped from both the default aggregation and the style
pass. The screen is on by default; `--no-anomaly-filter` disables it.

### Smart matchmaking

`SmartMatchmaker` (`server/src/matchmaking/smart.ts`) replaces uniform pair
selection behind the same `MatchmakingPort`. It reads pair game counts and each
model's rating-interval width via `MatchmakingStatsPort`, then samples a pair
**proportional to an information score**: `coldness = 1/(1+games)` (favor
under-evaluated pairs) plus normalized rating uncertainty (favor high-variance
matchups; unrated models count as maximally uncertain). A small floor keeps
every pair reachable so the comparison graph stays connected. It is the default;
`MATCHMAKER=random` restores `RandomMatchmaker`.

## Frontend

The headless hooks live in the published **`@omni-arena/react`** SDK
(`packages/react-sdk/`), and the demo imports them — a single source of truth.
The package is deliberately layered: the protocol, session, stream, and vote
concerns are **framework-free modules**, and each hook is a thin React shell over
them, so a non-React (or server-side) client can reuse the same wire logic
instead of reimplementing it.

| Module | Exports | Responsibility |
|---|---|---|
| `protocol.ts` | `parseArenaMatchup`, `parseArenaReveal`, `parseArenaSlotError`, `isArenaSlot`/`isArenaVote`/`isDecisiveVote`, `ARENA_VOTE_VALUES` | Narrow untrusted wire JSON into typed events; the one place the wire shape is known |
| `session.ts` | `getSessionId`, `ARENA_SESSION_STORAGE_KEY` | Anonymous session ID, persisted in `localStorage`, degrading to in-memory when storage is unavailable |
| `stream.ts` | `readArenaStream`, `createArenaSseDecoder` | Incremental SSE decoding over a `ReadableStream`, independent of any hook |
| `vote.ts` | `submitArenaVote` | One `POST /api/arena/vote` with the matchup token |
| `useArenaChat.ts` | `useArenaChat` | POSTs the prompt, drives `readArenaStream` into per-slot state, votes through `submitArenaVote`, and exposes revealed identities only after a successful vote |
| `useArenaVote.ts` | `useArenaVote` | Voting on its own, for a UI that renders the stream itself (the integrations do) |
| `useArenaLeaderboard.ts` | `useArenaLeaderboard` | Leaderboard payload including rating context |
| `useArenaAnalytics.ts` | `useArenaSummary`, `useArenaHeadToHead`, `useArenaModelMetrics`, `useArenaActivity`, `useArenaStyleControl`, `useArenaRatingHistory` | One hook per analytics endpoint, all with the same `{ data, refresh, error }` shape |

Every hook accepts an optional `baseUrl` (default `""` = same-origin/proxied).
See [SDK](sdk.md).

The demo app (`web/`) is a two-page SPA under `react-router-dom` (the server's
SPA fallback makes deep links work in production):

- **`/` — ArenaPage** (`web/src/routes/ArenaPage.tsx`): the original demo —
  prompt box, two anonymous markdown panes, five vote buttons, reveal, and the
  leaderboard. When a model has a worker-computed rating, the leaderboard shows
  the Elo-like rating with its ±CI half-width; otherwise it falls back to the
  win-rate percentage. When a style-controlled rating exists, it is shown
  alongside as `style <rating>`.
- **`/insights` — InsightsPage** (`web/src/routes/InsightsPage.tsx`): the
  analytics dashboard — a summary stat strip plus four tabs of charts
  (`web/src/dashboard/`, chart primitives in `web/src/charts/`):
  - **Rankings** — win-rate lollipop diverging from a 50% reference line,
    Bradley-Terry forest plot with 95% CI whiskers, raw-vs-style-controlled
    dumbbell, rank-shift bump chart, and vote-outcome stacked bars. Built
    entirely from the leaderboard payload.
  - **Head-to-head** — pair win-rate matrix (CSS grid, win-rate/games toggle,
    click-to-drill-down), pair drill-down card, tie-rate-per-pair bars, and a
    connectivity callout grouping models by `componentId`.
  - **Style & bias** — the style-coefficient panel, per-model slot-A vs slot-B
    position-bias dumbbell, verbosity/latency/markdown-density vs win-rate
    scatters, and per-model latency spread (p50–p90).
  - **Activity** — rating-over-time lines (from `model_rating_history`),
    stacked vote volume by outcome, and cumulative games per model.

  Ranked row charts (lollipop, forest, dumbbells, bars, matrix) are hand-rolled
  CSS grid/SVG for precise control; time series and scatters use `recharts`.

  Because every chart is derived from recorded votes, a fresh deployment has
  nothing to plot. Individual cards can only report *what* is missing, so
  `GettingStartedNotice` states the remedy once at the page level: the
  [demo-data seeder](setup.md#demo-data) when no votes exist, the worker command
  when votes exist but no fit does. It disappears once both are present. The page
  fetches the summary aggregate once and passes it to both the stat strip and the
  notice rather than each hook self-fetching.
  Each tab is a **nested route** (`/insights/rankings`, `/insights/head-to-head`,
  `/insights/style`, `/insights/activity`; the index redirects to `rankings`), so
  a tab is a shareable deep link rather than component state, and each tab is
  lazily imported on its own — the voting page never pays for the charting
  bundle, and opening one tab does not load the other three. Unknown paths
  redirect to `/`.

Beyond the bundled demo, two reference integrations live in
[`examples/`](../../examples/): a Next.js + Vercel AI SDK app
(`examples/vercel-ai-chatbot/`) and an assistant-ui app (`examples/assistant-ui/`),
both driving arena mode through the Vercel AI SDK adapter. They are exercised by
the deterministic end-to-end suite in `e2e/` (`npm run e2e`, Playwright + the
mock provider), which also asserts the raw `vercel-ai` and `ag-ui` wire streams.
See the [integration guide](integration.md) and [Setup](setup.md).

## Integrations layer

[`integrations/`](../../integrations/) is the layer above the examples: instead of
apps written for the arena, it wires the arena into **real upstream chat UIs at
pinned revisions**, which is what turns "the protocol should work" into evidence
that it does. Each directory is outside the npm workspace with its own
`package.json`, lockfile, tests, and README, so a root install never builds them
and an upstream's dependency tree cannot affect the published packages.

| Directory | Upstream | Protocol | Shape |
|---|---|---|---|
| `integrations/vercel-ai-chatbot/` | `vercel/ai-chatbot` | `vercel-ai` | Pinned clone + overlay |
| `integrations/assistant-ui/` | assistant-ui monorepo, `examples/with-ag-ui` | `ag-ui` | Pinned clone + overlay |
| `integrations/open-webui/` | Open WebUI container image | `openai` | Published image + OpenAI-compatible bridge |

The two Node integrations share one mechanism: `upstream.json` pins the exact
commit, `.upstream/` is the gitignored clone, `overlay/` holds the arena sources
copied in verbatim, and `scripts/overlay.mjs` applies **anchored** patches to
upstream's own files — each anchor must match exactly once, so an upstream that
moved a line fails setup loudly instead of yielding a half-integrated app. The
arena-specific code is therefore reviewable in `overlay/` without reading a diff
against a vendored tree.

Open WebUI is the case that shaped the server: it sends **one request per model**
for a compare turn, which is what [slot join](#slot-join-one-matchup-across-two-requests)
exists to serve, and it reaches the arena through a small OpenAI-compatible
bridge in `integrations/open-webui/bridge/` rather than an overlay, because the UI
ships as a container image. All three run key-free against the mock provider.

## What is intentionally not built yet

- **Mid-stream steering execution** — the control plane's `steer` message is a
  schema-validated, documented stub returning a negative ack; the instruction is
  not yet threaded into the running producers in `ArenaCore`. `stop` is real.
- **`sampled` trigger** — `ARENA_TRIGGER` accepts only `always` and `manual`
  (`arenaTriggerSchema` in `server/src/arena/mode.ts`), so `sampled` is rejected at
  boot rather than silently behaving like another mode. The seam exists —
  `resolveArenaPlan` already takes an injectable `rng` — but nothing branches on it
  yet. Likewise the `shadow` plan variant is declared so consumers can be
  exhaustive ahead of time, and is currently unreachable. See
  [Setup → trigger modes](setup.md#trigger-modes).
- **Multimodal input** — deferred.

OmniArena does not scrub or redact stored prompts/responses — content is
persisted as received.
