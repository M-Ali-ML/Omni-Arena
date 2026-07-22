# Rating methodology

OmniArena turns a stream of blind pairwise votes into a statistically principled
leaderboard. The rating engine is a standalone Python worker (`worker/`,
package `omniarena_rating`) that runs **off the request hot path**: it screens
anomalous sessions, aggregates votes in-database, fits a Bradley-Terry model with
explicit tie handling, attaches confidence intervals validated by a bootstrap,
splits the comparison graph into components, and upserts the results the
leaderboard reads. This document explains each step and grounds every claim in
the implementation.

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
loop mode each refit is **warm-started** from the previous solution's full
optimiser vector (`[r_0…r_{n−1}, η]`), so an incremental refit converges in very
few L-BFGS-B iterations. The warm state lives only in memory between refits (it
is not persisted). Warm-starting is skipped when the model set changes (the
vector shape no longer matches), which naturally falls back to a cold full refit.
The Docker Compose `worker` service runs the loop against Postgres.

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

| Test | Null hypothesis | Catches |
|---|---|---|
| Volume | Poisson upper-tail `P(X ≥ n)` vs mean votes/session | vote-stuffing |
| Position bias | two-sided binomial on decisive left/right vs `p = 0.5` (slots are randomized) | always-left / always-right bots |
| Speed | median inter-vote gap below a floor (default 1.5 s), when timestamps exist | automated clicking |

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
the `styleControlled*` fields are `null` until the heavier style pass runs.
Clients treat them as optional and fall back to `winRate`.

## Verification

The worker suite (`worker/tests/`, pure-Python `pytest`, no database) checks the
analytic gradient against finite differences, recovers known synthetic ratings,
verifies tie modeling and anchoring, confirms the Fisher-information CIs agree
with the multinomial bootstrap, checks connectivity splits a disconnected graph,
verifies style control shrinks a pure verbosity advantage, and flags synthetic
spam/bot sessions in the anomaly screen. See [Setup → Rating worker](setup.md) to
run them.
