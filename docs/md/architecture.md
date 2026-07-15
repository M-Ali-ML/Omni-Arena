# Architecture

OmniArena is a small, self-hosted service for blind, multi-turn side-by-side LLM
comparisons. This document describes the architecture **as implemented today**
(through Phase 2). The target end-state lives in [`pre-docs/architecture.md`](../../pre-docs/architecture.md)
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
   ├─ RandomMatchmaker   picks + blind-randomizes a model pair
   ├─ MatchupTokenService HMAC-signed matchup tokens
   ├─ provider adapters   Google / OpenAI / Ollama / vLLM / host proxy
   ├─ PiiScrubberPort     no-op placeholder before persistence
   └─ PostgresRepository conversations / turns / matchups / responses / preferences
              │
              ▼
        [ PostgreSQL ] ◀──── writes model_ratings ──── [ worker (Python) ]
              │                                          Bradley-Terry + tie model,
              ▼                                          Fisher-info CIs, connectivity
     [ configured model endpoints ]                      (periodic batch refit)
```

The rating worker runs **off the hot path**: the request/stream/vote loop never
waits on it. It periodically aggregates votes in-database, refits ratings, and
upserts a `model_ratings` snapshot the leaderboard reads via LEFT JOIN.

## Hexagonal boundaries (ports)

Even in the MVP, the core is separated from its edges by small interfaces in
`server/src/core/ports.ts`:

| Port | MVP implementation | Future replacement |
|---|---|---|
| `ModelProviderPort` | Google, OpenAI-compatible, Ollama, and host-proxy implementations | additional providers |
| `ProviderResolverPort` | `ProviderRegistry` (name → provider) | unchanged |
| `MatchmakingPort` | `RandomMatchmaker` | smart sampling / King-of-the-Hill |
| `PreferenceRepositoryPort` | `PostgresRepository` | unchanged |
| `LeaderboardPort` | win-rate SQL + `model_ratings` LEFT JOIN in `PostgresRepository` | style-controlled ratings (Phase 3) |
| `PiiScrubberPort` | `NoopPiiScrubber` placeholder | real PII detection/redaction |

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

Prompts and responses pass through `PiiScrubberPort` immediately before
persistence. Phase 1 intentionally wires a no-op implementation; it establishes
the security boundary but does not redact data yet.

## Blind voting integrity

- Model identities are never sent before a vote. `matchup_started` carries only
  slot IDs and a matchup token.
- The matchup token is HMAC-SHA256 signed (`server/src/token.ts`), contains
  `matchupId`, both slot model IDs, an optional session ID, and a 15-minute
  expiry. Only its SHA-256 hash is stored in the database.
- Voting verifies signature, expiry, claims-vs-database consistency, and the
  stored hash; a unique constraint enforces one vote per matchup.

## Bradley-Terry rating worker (Phase 2)

The `worker/` package (`omniarena_rating`) computes the style-agnostic default
leaderboard rating. It is a separate Python process (NumPy/SciPy), not part of
the Fastify request path, and follows a strict *aggregate-then-compute* design.

| Step | Module | What it does |
|---|---|---|
| Aggregate | `aggregate.py` | One SQL `GROUP BY` collapses `preferences` ⋈ `matchups` into canonical `(model_lo, model_hi, wins_lo, wins_hi, ties)` triples. `skip` excluded. O(votes) → O(model pairs); raw rows never leave Postgres. |
| Fit | `bradley_terry.py` | Log-parameterized BT (`r_i = log θ_i`) MLE via SciPy **L-BFGS-B** with an analytic gradient. **Rao-Kupper** tie modeling (symmetric ordered logit, threshold `±η`). Weak **ridge prior** for identifiability + regularization. **Sum-to-zero anchoring**. **Warm-start** for incremental refits. |
| Intervals | `confidence.py` | Primary CIs from the **inverse Hessian** (observed Fisher information / Laplace approximation), projected through the anchoring contrast. A **multinomial bootstrap** over the aggregated triples validates them. |
| Connectivity | `connectivity.py` | Union-find over the comparison graph; ratings only comparable within a connected component. Isolated models get their own component id and wide intervals. |
| Write back | `writeback.py` | Idempotent upsert into `model_ratings`. |

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

## Frontend

`web/src/useArenaChat.ts` is a headless React hook: it POSTs the prompt,
parses the multiplexed SSE stream into per-slot state, submits votes with the
matchup token, and exposes revealed identities only after a successful vote.
`web/src/useArenaLeaderboard.ts` fetches the leaderboard. `App.tsx` is a
single-page demo (prompt box, two anonymous panes with markdown rendering,
five vote buttons, reveal, leaderboard). When a model has a worker-computed
rating, the leaderboard shows the Elo-like rating with its ±CI half-width;
otherwise it falls back to the win-rate percentage.

## What is intentionally not built yet

Style-controlled ratings (joint confounder regression), anomaly detection, and
smart matchmaking (all Phase 3); protocol adapters (Vercel AI SDK, AG-UI/A2UI,
OpenAI SSE), WebSocket control plane, real PII redaction, and the published SDK
package (Phase 4+).
