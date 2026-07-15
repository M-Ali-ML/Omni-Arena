# Architecture

OmniArena is a small, self-hosted service for blind, multi-turn side-by-side LLM
comparisons. This document describes the architecture **as implemented today**
(through Phase 3). The target end-state lives in [`pre-docs/architecture.md`](../../pre-docs/architecture.md)
and `artifacts/vision.md` (local-only, gitignored — not committed).

Related: [API](api.md) · [Data model](data-model.md) · [Setup](setup.md)

## System overview

The repo is an npm workspace monorepo with two packages:

| Package | Path | Role |
|---|---|---|
| `@omni-arena/server` | `server/` | Fastify API: matchmaking, dual-model SSE streaming, voting, leaderboard |
| `@omni-arena/web` | `web/` | Vite + React demo UI with in-repo headless hooks |
| `omniarena-rating` | `worker/` | Python Bradley-Terry rating worker (NumPy/SciPy) |

```
[ web (React demo) ]
   │ useArenaChat / useArenaLeaderboard
   │ (Vite dev proxy → :3001)
   ▼
[ server (Fastify) ]
   ├─ routes/chat        POST /api/arena/chat   → multiplexed SSE
   ├─ routes/vote        POST /api/arena/vote   → reveal identities
   ├─ routes/leaderboard GET  /api/arena/leaderboard  (win-rate + ratings)
   ├─ ArenaCore          fan-out to two providers, one event stream
   ├─ SmartMatchmaker    prioritizes under-sampled / high-variance pairs
   │                     (RandomMatchmaker still available; MATCHMAKER=random)
   ├─ MatchupTokenService HMAC-signed matchup tokens
   ├─ provider adapters   Google / OpenAI / Ollama / vLLM / host proxy
   └─ PostgresRepository conversations / turns / matchups / responses / preferences
              │
              ▼
        [ PostgreSQL ] ◀── model_ratings + model_style_ratings ── [ worker (Python) ]
              │                                          BT + tie model, Fisher CIs,
              ▼                                          anomaly screen, style control
     [ configured model endpoints ]                      (periodic batch refit)
```

The rating worker runs **off the hot path**: the request/stream/vote loop never
waits on it. It periodically screens anomalous voting sessions, aggregates votes
in-database, refits ratings, and upserts a `model_ratings` snapshot the
leaderboard reads via LEFT JOIN. A heavier periodic pass fits style-controlled
ratings into `model_style_ratings`.

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
| `LeaderboardPort` | win-rate SQL + `model_ratings` + `model_style_ratings` LEFT JOINs in `PostgresRepository` | more surfaced rating variants |

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

The chat route converts internal events to public SSE events with
`toPublicEvent()` and persists each `slot_done` as a `responses` row. Internal
completion events include TTFT, stream duration, token count/source, Markdown
density, and provider-reported model version. Each matchup stores the configured
`HARNESS_VERSION`.

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

## Bradley-Terry rating worker

The `worker/` package (`omniarena_rating`) computes the style-agnostic default
leaderboard rating. It is a separate Python process (NumPy/SciPy), not part of
the Fastify request path, and follows a strict *aggregate-then-compute* design.

| Step | Module | What it does |
|---|---|---|
| Anomaly screen | `anomaly.py` | Runs **before** aggregation: p-value tests over anonymous sessions flag spam/malicious voters, whose votes are excluded from the fit. See [Anomaly detection](#anomaly-detection-phase-3). |
| Aggregate | `aggregate.py` | One SQL `GROUP BY` collapses `preferences` ⋈ `matchups` into canonical `(model_lo, model_hi, wins_lo, wins_hi, ties)` triples. `skip` and flagged sessions excluded. O(votes) → O(model pairs); raw rows never leave Postgres. |
| Fit | `bradley_terry.py` | Log-parameterized BT (`r_i = log θ_i`) MLE via SciPy **L-BFGS-B** with an analytic gradient. **Rao-Kupper** tie modeling (symmetric ordered logit, threshold `±η`). Weak **ridge prior** for identifiability + regularization. **Sum-to-zero anchoring**. **Warm-start** for incremental refits. |
| Intervals | `confidence.py` | Primary CIs from the **inverse Hessian** (observed Fisher information / Laplace approximation), projected through the anchoring contrast. A **multinomial bootstrap** over the aggregated triples validates them. |
| Connectivity | `connectivity.py` | Union-find over the comparison graph; ratings only comparable within a connected component. Isolated models get their own component id and wide intervals. |
| Style control | `style.py` | Heavier **periodic pass** on raw votes: joint style-controlled BT regression. See [Style-controlled ratings](#style-controlled-ratings-phase-3). |
| Write back | `writeback.py` | Idempotent upsert into `model_ratings` (default) and `model_style_ratings` + `style_control_coefficients` (style pass). |

Ratings are reported on an Elo-like display scale
`display = 1000 + (400/ln 10)·r`, centered per connected component. See the
[rating methodology](#rating-methodology) below.

The worker runs one-shot (`python -m omniarena_rating`) or as a periodic loop
(`--loop`) with warm-started refits; the Docker Compose `worker` service runs
the loop. Only `both_good`/`both_bad` count as ties; `skip` votes are dropped.

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

### Style-controlled ratings (Phase 3)

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

### Anomaly detection (Phase 3)

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

### Smart matchmaking (Phase 3)

`SmartMatchmaker` (`server/src/matchmaking/smart.ts`) replaces uniform pair
selection behind the same `MatchmakingPort`. It reads pair game counts and each
model's rating-interval width via `MatchmakingStatsPort`, then samples a pair
**proportional to an information score**: `coldness = 1/(1+games)` (favor
under-evaluated pairs) plus normalized rating uncertainty (favor high-variance
matchups; unrated models count as maximally uncertain). A small floor keeps
every pair reachable so the comparison graph stays connected. It is the default;
`MATCHMAKER=random` restores `RandomMatchmaker`.

## Frontend

`web/src/useArenaChat.ts` is a headless React hook: it POSTs the prompt,
parses the multiplexed SSE stream into per-slot state, submits votes with the
matchup token, and exposes revealed identities only after a successful vote.
`web/src/useArenaLeaderboard.ts` fetches the leaderboard. `App.tsx` is a
single-page demo (prompt box, two anonymous panes with markdown rendering,
five vote buttons, reveal, leaderboard). When a model has a worker-computed
rating, the leaderboard shows the Elo-like rating with its ±CI half-width;
otherwise it falls back to the win-rate percentage. When a style-controlled
rating exists, it is shown alongside as `style <rating>`.

## What is intentionally not built yet

Protocol adapters (Vercel AI SDK, AG-UI/A2UI, OpenAI SSE), the WebSocket control
plane, and the published SDK package (Phase 4+); the OSS launch collateral
(Phase 5). OmniArena does not scrub or redact stored prompts/responses — content
is persisted as received.
