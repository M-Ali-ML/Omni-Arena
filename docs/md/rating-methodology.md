# Rating methodology

OmniArena turns a stream of blind pairwise votes into a statistically principled
leaderboard. The rating engine is a standalone Python worker (`worker/`,
package `omniarena_rating`) that runs **off the request hot path**: it screens
anomalous sessions, aggregates votes in-database, fits a Bradley-Terry model with
explicit tie handling, attaches confidence intervals validated by a bootstrap,
splits the comparison graph into components, and upserts the results the
leaderboard reads — appending a [history snapshot](#rating-history) per refit so
the ratings can also be charted over time. This document explains each step and
grounds every claim in the implementation — including [what the engine cannot
rate](#what-the-engine-cannot-rate), since everything below needs *pairwise*
input.

Related: [Architecture → Rating worker](architecture.md) · [API → leaderboard](api.md) · [Data model](data-model.md) · [Setup → Rating worker](setup.md) · [Integration](integration.md)

## Why Bradley-Terry

Votes are **pairwise preferences**: for each matchup a human says A beat B, B
beat A, both were good, both were bad, or skip. The Bradley-Terry (BT) model is
the canonical model for exactly this data. It assigns each model a latent
strength and predicts the probability that one beats another from the difference
of their strengths — no absolute score, only relative comparisons, which is all a
preference vote provides.

OmniArena parameterizes strengths on a **log scale**, `r_i = log θ_i`
(`bradley_terry.py`). For two models `a`, `b` with `d = r_a − r_b`, the base BT
win probability is the logistic `P(a ≻ b) = σ(d)`. Working in log-space makes the
log-likelihood **convex**, so the fit has a unique optimum reachable by a
standard solver.

## What the engine cannot rate

Bradley-Terry is a model **of comparisons**. Every term in its likelihood is a
contest between two models; there is no term for a verdict on one answer viewed
alone. That is a real bound on what OmniArena can rate, and it lands precisely
where the arena is most constrained — so it is stated here rather than left to be
inferred.

- **A `single` round produces nothing rateable.** Under
  `ARENA_TRIGGER=manual` (or a `sampled` miss), a request that does not engage
  is served by one model (`ARENA_DEFAULT_MODEL`) and **persists nothing at all**
  — no `matchups` row, no
  responses, no vote token (`server/src/routes/chat.ts`). Aggregation reads
  `preferences ⋈ matchups`, so such a round is not *filtered out* of the fit the
  way a `skip` vote or a flagged session is; it never reaches the database to be
  filtered. See
  [Integration → identifiers you cannot use are not sent](integration.md#identifiers-you-cannot-use-are-not-sent).
- **A `shadow` round persists both answers but is not human-votable.** Under
  `ARENA_EXPOSURE=shadow`, both responses and a `matchups.mode='shadow'` row are
  written, but `POST /api/arena/vote` returns `403` and no preference is
  recorded. Until an auto-judge path exists, shadow rows also contribute nothing
  to the BT fit.
- **One-sided feedback is not a comparison, and there is no ingestion path for
  it.** A thumbs-up on a lone answer says nothing about a *pair*, and BT has
  nowhere to put it. `POST /api/arena/vote` accordingly accepts only an
  HMAC-signed matchup token naming two slots ([API → vote](api.md)); no
  endpoint, column, or worker code path records a per-response rating.
- **A deployment serving mostly `single` rounds should expect no ratings.** The
  worker has nothing to fit, so `rating`, `ratingStdError`,
  `confidenceInterval`, and `componentId` stay `null` and the leaderboard falls
  back to win/loss/tie counts drawn from whatever matchup rounds did occur — of
  which there may be none. A model only ever served in `single` mode never
  enters the comparison graph and stays unrated indefinitely, however much
  traffic it answers.

The engine's rigor is real, but it is rigor *about pairwise data*: Rao-Kupper
ties instead of a `y = 0.5` half-win hack, Fisher-information intervals, joint
style control, and a pre-fit anomaly screen are all concrete improvements over a
hand-rolled Elo update loop — **given comparisons to fit**. None of them
substitutes for having comparisons. For a client that genuinely cannot present
two answers, such as a strict OpenAI-compatible UI with one message channel,
OmniArena today has a graceful *serving* story (`single`, `votable: false`) and
no rating story; the comparison has to come from somewhere. That constraint is
not hypothetical — Open WebUI, facing it, shipped its own single-blind
thumbs-rated leaderboard with a hand-rolled Elo, as
[`integrations/open-webui/`](../../integrations/open-webui/) documents.

### Not built: regenerate-as-slot-B

There is a candidate fix worth naming precisely because it is easy to assume it
exists: turn two sequential single answers into one genuine pair — serve an
answer, regenerate the same prompt with a second model, persist the two as a
matchup, and collect a real pairwise vote from a client that can only show one
answer at a time. **None of it is implemented.** There is no regenerate-as-slot-B
mode, no schema for it, no endpoint, and no worker support. Do not confuse that
idea with `ARENA_EXPOSURE=shadow`, which **is** shipped: the incumbent streams,
the challenger runs silently, both responses land in Postgres with
`matchups.mode='shadow'`, and human votes are rejected (`403`). Shadow rows are
not yet fed to an auto-judge, so they also produce no rating signal today
(`server/src/arena/mode.ts`, see [Setup → Trigger and
exposure](setup.md#trigger-and-exposure)). The regenerate idea is recorded here
so it is not mistaken for a feature — do not plan an integration against it.

## The fit: log-parameterized MLE via L-BFGS-B

The engine fits ratings by **maximum likelihood** — maximizing the (penalized)
log-likelihood of the observed outcomes. Concretely it *minimizes* the penalized
negative log-likelihood with SciPy's **L-BFGS-B**
(`scipy.optimize.minimize(method="L-BFGS-B")`) supplying an **analytic
gradient** (`jac=True`). This is a standard quasi-Newton convex solver — not
hand-rolled gradient descent — so there is no learning rate to tune and it
converges in a handful of iterations. The parameter vector is
`[r_0, …, r_{n−1}, η]`: one log-strength per model plus the tie threshold `η`.

The analytic gradient is unit-tested against finite differences
(`worker/tests/`), and the solver is configured with tight tolerances
(`ftol=1e-12`, `gtol=1e-8`).

## Tie modeling: Rao-Kupper

Human voters produce genuine ties (`both_good` / `both_bad`), and a `y = 0.5`
half-win hack distorts the strengths. Instead the worker uses the **Rao-Kupper**
extension of Bradley-Terry — equivalent to a symmetric three-category ordered
logit with thresholds `±η` (`η ≥ 0`, a fitted parameter):

```
P(i beats j) = σ(d − η)
P(j beats i) = σ(−d − η)          with d = r_i − r_j
P(tie)       = σ(d + η) − σ(d − η)
```

A larger `η` widens the "tie band," so ties become more likely when the two
strengths are close. `η` is bounded below by a small floor (`_ETA_FLOOR = 1e-4`)
so the tie probability never collapses to exactly zero. `skip` votes are dropped
entirely (they are not a preference); only `both_good` / `both_bad` count as
ties.

## Identifiability, anchoring, and the ridge prior

Raw BT strengths are only defined **up to an additive constant** — adding the
same amount to every `r_i` leaves all differences (and thus all probabilities)
unchanged. Two mechanisms pin them down:

- **Anchoring.** After the fit, ratings are re-centred **sum-to-zero**
  (`anchor="mean"`, the default) — or pinned to a reference model
  (`anchor="reference"`). Centering happens *per connected component*
  (`report.py` → `_center_within_components`), since offsets *between* components
  are not identified.
- **Ridge prior.** A weak Gaussian prior on the ratings adds
  `½·ridge·‖r‖²` to the objective (`RATING_RIDGE`, default `0.01`;
  `STYLE_RIDGE`, default `0.05`, for the style pass). This one term does three
  jobs at once:
  1. **Identifiability** — it removes the additive-constant degeneracy, making
     the objective *strictly* convex.
  2. **Regularization** — sparsely-compared models are pulled toward the
     population mean (0) with wide intervals instead of diverging to ±∞.
  3. **Conditioning** — it keeps the Hessian invertible, which the
     Fisher-information covariance below depends on.

The ridge is applied to the strengths (and, in the style pass, the style
coefficients) but **never** to the tie threshold `η`.

## Confidence intervals: Fisher information, validated by bootstrap

Every rating ships with a 95% confidence interval. The **primary** method is
analytic (`confidence.py`):

- Under the ridge penalty the objective is smooth and strictly convex, so a
  **Laplace approximation** at the optimum gives a posterior covariance equal to
  the **inverse Hessian** of the penalized negative log-likelihood — the
  *observed Fisher information*. Per-model standard errors are the square roots
  of its diagonal: **one matrix computation instead of hundreds of refits.**
- The Hessian is built by central-differencing the analytic gradient, which
  keeps it exactly consistent with the objective actually optimized and costs
  O(n) gradient evaluations.
- Because ratings are only identified up to the anchor, the covariance is
  **projected through the same anchoring contrast** used for the point estimates
  (`_anchor_contrast`). Otherwise the barely-penalized common-mode (sum-to-zero)
  direction would dominate the diagonal and inflate every standard error.

The **validation** method is a **multinomial bootstrap** (`multinomial_bootstrap`).
It flattens the aggregated triples into outcome cells, draws each bootstrap
dataset from a single `Multinomial(N, observed_proportions)`, re-aggregates, and
refits (warm-started from the point estimate). The column standard deviations of
the resulting rating draws confirm the analytic standard errors — **without ever
touching raw vote rows**. A worker test asserts the two agree.

Reported intervals are `rating ± z·stderr` with `z ≈ 1.96` for 95%.

## Comparison-graph connectivity

BT ratings are only comparable within a **connected component** of the matchup
graph: if two clusters of models have never been compared (directly or
transitively), their relative rating is undefined. `connectivity.py` runs a
**union-find** over the aggregated pairs (an edge exists wherever a pair has any
real comparison) and assigns each model a `component_id`. The leaderboard
surfaces this id so clients can render **per-component leaderboards**; ratings
should only be compared within the same `componentId`. Isolated models get their
own component and wide, ridge-regularized intervals. When the graph is
disconnected the worker logs a warning.

## Display scale

Ratings are fit on the natural log-odds scale, then mapped to an **Elo-like
display scale** for the leaderboard (`report.py`):

```
display = 1000 + (400 / ln 10) · r        (SCALE = 400/ln10 ≈ 173.72)
```

`400/ln10` is the classic Elo constant: a **400-point gap ≈ 10× expected win
odds**, matching BT's `P = σ(r_i − r_j)`. Standard errors and CI half-widths
scale by the same factor, so intervals stay in display units. Centering is
per-component, then the baseline `1000` is added.

## Warm-started incremental vs periodic full refits

The worker runs either **one-shot** (`python -m omniarena_rating`) or as a
**periodic loop** (`--loop`, every `REFIT_INTERVAL_SECONDS`, default 300). In
loop mode most refits are **warm-started** from the previous solution's full
optimiser vector (`[r_0…r_{n−1}, η]`), so an incremental refit converges in very
few L-BFGS-B iterations. The warm state lives only in memory between refits (it
is not persisted). Warm-starting is skipped when the model set changes (the
vector shape no longer matches), which naturally falls back to a cold full refit.
The Docker Compose `worker` service runs the loop against Postgres.

An unbroken chain of warm starts would never independently confirm its own
answer, so every `FULL_REFIT_EVERY` refits (default 12 — **hourly** at the
default interval, and `0` disables it) the worker **discards the warm state and
fits from scratch**. This is the ground-truth pass: it bounds how long an
incremental chain can accumulate drift, and it is affordable precisely because
the fit input is bounded by model pairs rather than vote volume (see
[aggregate-then-compute](#aggregate-then-compute-why-it-scales)). The loop's
first refit is already cold, so the forced passes land on refits 1, 13, 25, …
Every refit logs `mode=full` or `mode=incremental`.

The cold pass is also used as a **validation signal**. Because the ridge makes
the objective strictly convex, the raw optimiser vector is the *unique* minimiser
— a warm-started fit of the same aggregates must reach the same point. So the
ground-truth pass re-runs the incremental path over those same aggregates (cheap:
it starts at the previous solution) and warns when the two disagree by more than
**half a standard error** on any model. Standard-error units matter here: L-BFGS-B
stops on a *relative* function tolerance, so its parameter accuracy loosens as
the log-likelihood grows with vote volume, and an absolute display-point
threshold would not transfer between a hundred votes and a million. Holding the
data fixed is what makes this a check on the solver rather than a measurement of
the rating movement new votes would have caused anyway.

## Aggregate-then-compute (why it scales)

The default fit **never sees raw vote rows**. `aggregate.py` runs one SQL
`GROUP BY` that collapses `preferences ⋈ matchups` into canonical
`(model_lo, model_hi, wins_lo, wins_hi, ties)` triples, with pair ordering
canonicalized via `LEAST`/`GREATEST`. With `n` models the fit input is bounded by
~`3·C(n, 2)` rows no matter how many millions of votes exist (`O(votes)` →
`O(model pairs)`), and raw content stays in the database.

## Pre-fit anomaly screen

Before aggregation, `anomaly.py` screens anonymous voting sessions
(`preferences.anonymous_session_id`) with three p-value tests; any rejection
(Bonferroni-adjusted at `α/3`) excludes that session from **both** the default
and style fits. It is on by default (`--no-anomaly-filter` disables it).

| Test | Null hypothesis | Catches | Runs when |
|---|---|---|---|
| Volume | Poisson upper-tail `P(X ≥ n)` vs mean votes/session | vote-stuffing | ≥ 20 votes in the session |
| Position bias | two-sided binomial on decisive left/right vs `p = 0.5` (slots are randomized) | always-left / always-right bots | ≥ 15 decisive votes |
| Speed | median inter-vote gap below a floor (default 1.5 s) | automated clicking | ≥ 8 vote timestamps |

The significance level is `α = 1e-3`, so each test rejects below `α/3 ≈ 3.3e-4`.
The minimum-sample gates above are why a small session is never flagged: a
handful of votes cannot be distinguished from a fast, one-sided human. Votes
with no `anonymous_session_id` are always kept — they cannot be attributed to a
voter, so there is nothing to exclude.

## Style-controlled ratings

Human voters reward **superficial traits** — longer answers, heavier markdown,
faster first tokens, and the left-hand slot — that inflate a model's apparent
strength without reflecting quality. Rather than a separate post-hoc regression,
OmniArena follows the LMSYS approach and folds these confounders into the **same**
Bradley-Terry logistic regression as extra covariates (`style.py`), so model
strengths and style coefficients are estimated **jointly**. For a vote on a
matchup with slot-A model `a` and slot-B model `b`:

```
d = (r_a − r_b) + β · x            P(A ≻ B) = σ(d − η)
```

The per-vote **style delta** `x` (slot A minus slot B) has five terms:

| Feature | Delta of | Note |
|---|---|---|
| `position` | constant `1.0` | orientation is fixed to (A, B), so its coefficient is exactly the systematic left-slot advantage |
| `verbosity` | `output_token_count` | length preference |
| `formatting` | `markdown_density` | markdown preference |
| `latency_ttft` | `ttft_ms` | first-token speed preference |
| `latency_duration` | `stream_duration_ms` | total-duration preference |

Ties reuse the same Rao-Kupper threshold `η`. Continuous features are
standardized for conditioning; the fitted coefficients can be mapped back to raw
units (`coefficients_raw_scale`). A ridge on **all** coefficients (strengths and
style betas, `STYLE_RIDGE` default `0.05`) keeps the joint fit stable when the
covariates correlate. Standard errors use the same inverse-Hessian machinery,
projected through the sum-to-zero anchor.

Because the deltas vary **per vote**, this fit **cannot** use the O(model pairs)
aggregation — it runs on raw vote rows joined across
`preferences ⋈ matchups ⋈ responses`, so it is a heavier, less frequent pass
(`--style`) kept separate from the fast default path. Results land in
`model_style_ratings` (rating + CI, per component) and the fitted coefficients in
`style_control_coefficients`; the leaderboard exposes them as
`styleControlledRating`.

## What the leaderboard exposes

`GET /api/arena/leaderboard` LEFT JOINs the worker's output onto the win/loss/tie
counts. The rating fields (see [API → leaderboard](api.md)):

| Field | Meaning |
|---|---|
| `rating` | Bradley-Terry rating on the Elo-like display scale |
| `ratingStdError` | Standard error (same scale) |
| `confidenceInterval` | 95% CI `{ lower, upper }` from Fisher information |
| `componentId` | Connected component; **ratings only comparable within a component** |
| `styleControlledRating` | BT rating with verbosity/formatting/latency/position regressed out jointly |
| `styleControlledStdError` | Standard error of the style-controlled rating |
| `styleControlledConfidenceInterval` | 95% CI for the style-controlled rating |

The `rating*`/`componentId` fields are `null` until the default worker pass runs;
the `styleControlled*` fields are `null` until the heavier style pass runs. They
also stay `null` for a model with no comparisons to fit — see [what the engine
cannot rate](#what-the-engine-cannot-rate). Clients treat them as optional and
fall back to `winRate`.

### Where the leaderboard's counts come from

The win/loss/tie columns are **not** the worker's; they are aggregated by the
server directly over `models ⋈ matchups ⋈ preferences` for every enabled model,
so they exist from the first vote and never wait on a refit:

| Field | Counted as |
|---|---|
| `wins` | votes whose `winner_model_id` is this model |
| `losses` | `left`/`right` votes on a matchup this model was in where the winner is another model |
| `ties` | `both_good` + `both_bad` votes on its matchups |
| `skips` | `skip` votes on its matchups |
| `totalVotes` | every vote on its matchups, skips included |
| `winRate` | `wins / (wins + losses + ties)`, or `0` when that denominator is zero |

The `games` figure the worker itself reports (persisted with each rating and
exposed by the [rating history](#rating-history)) is a different number: it is
summed from the *aggregated pair triples*, so it counts non-skip votes only, and
both models of a pair are credited with the same total. A model whose only
comparisons came from a session the anomaly screen excluded therefore has
`totalVotes > 0` and `games = 0`.

## Rating history

`model_ratings` is an **upsert** keyed by model, so it only ever holds the
latest fit — reading it tells you where a model stands, never how it got there.
Every refit therefore also appends a snapshot row per model to
`model_rating_history` (migration `005_rating_history.sql`), in the **same
transaction** as the upsert, so the two can never disagree about a refit:

| Column | Meaning |
|---|---|
| `model_id`, `computed_at` | Primary key. `computed_at` is `NOW()`, which is transaction-stable, so every row a refit writes shares one timestamp and one refit is one point on the x-axis |
| `rating`, `rating_stderr`, `ci_lower`, `ci_upper` | Exactly the display-scale values written to `model_ratings` |
| `component_id` | The component this fit put the model in; it can change between refits as bridging games arrive |
| `games` | Non-skip comparisons behind this snapshot (see [where the leaderboard's counts come from](#where-the-leaderboards-counts-come-from)) |

Consequences worth knowing before reading a chart:

- **The series is per-refit, not per-vote.** At the default cadence that is one
  point every `REFIT_INTERVAL_SECONDS`, and a refit that skipped (no enabled
  models, or no comparisons yet) writes nothing at all.
- **Both refit modes append.** A warm-started incremental refit and a cold
  ground-truth pass produce indistinguishable rows, which is exactly what makes
  the [warm-drift check](#warm-started-incremental-vs-periodic-full-refits) a
  check on the solver rather than something a reader has to do by eye.
- **Ratings move without any model changing.** They are anchored sum-to-zero
  per component, so one model's improvement lowers every other rating in its
  component, and a component split or merge re-anchors the whole group.
- **The style pass has no history.** `model_style_ratings` and
  `style_control_coefficients` are upserts with no append-only sibling, so
  style-controlled ratings and style coefficients have a current value only.

The table is exposed as `GET /api/arena/analytics/rating-history` (see
[API → analytics](api.md)) and is what the rating-over-time chart reads. It is
empty until the first refit after the migration; rows are never updated or
deleted, and a deleted model's snapshots go with it (`ON DELETE CASCADE`).

## Verification

The worker suite (`worker/tests/`, pure-Python `pytest`, no database) checks the
analytic gradient against finite differences, recovers known synthetic ratings,
verifies tie modeling and anchoring, confirms the Fisher-information CIs agree
with the multinomial bootstrap, checks connectivity splits a disconnected graph,
verifies style control shrinks a pure verbosity advantage, flags synthetic
spam/bot sessions in the anomaly screen, asserts the loop alternates cold and
warm refits on the configured cadence, and asserts the history snapshot is
appended from the same rows and inside the same transaction as the
`model_ratings` upsert. See [Setup → Rating worker](setup.md) to run them.
