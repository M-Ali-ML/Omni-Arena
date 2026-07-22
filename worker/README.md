# OmniArena Rating Worker

A standalone Python worker that turns aggregated pairwise votes into a
statistically principled leaderboard. The default path is the **style-agnostic**
Bradley-Terry fit; a heavier periodic pass adds style-controlled ratings and a
pre-fit anomaly screen. Smart matchmaking lives in the Node server, not here.

## What it does

1. **Aggregate in-database** (`aggregate.py`): one SQL `GROUP BY` collapses
   `preferences` ⋈ `matchups` into canonical `(model_lo, model_hi, wins_lo,
   wins_hi, ties)` triples. `skip` votes are excluded. The fit input is bounded
   by ~`3·C(n,2)` rows no matter how many millions of votes exist — raw rows
   never leave Postgres (O(votes) → O(model pairs)).
2. **Fit Bradley-Terry** (`bradley_terry.py`): log-parameterized (`r_i = log θ_i`)
   MLE via `scipy.optimize.minimize(method="L-BFGS-B")` with an **analytic
   gradient** — a standard convex solver, not hand-rolled gradient descent.
   Ties are modelled with the **Rao-Kupper** extension (a symmetric
   three-outcome ordered logit with thresholds `±η`), not a `y=0.5` hack. A weak
   **ridge prior** provides identifiability, regularises sparsely-compared
   models, and keeps the Hessian invertible. Ratings are **anchored**
   sum-to-zero (or to a reference model). Warm-start is supported for fast
   incremental refits.
3. **Confidence intervals** (`confidence.py`): primary CIs come from the
   **inverse Hessian** of the penalised log-likelihood (observed Fisher
   information / Laplace approximation), projected through the anchoring
   contrast so they describe the identified ratings. A **multinomial bootstrap**
   over the aggregated triples validates the analytic intervals without touching
   raw rows.
4. **Connectivity** (`connectivity.py`): union-find over the comparison graph
   finds connected components. Ratings are only comparable within a component;
   isolated models get their own component id and wide (ridge-regularized)
   intervals.
5. **Write back** (`writeback.py`): idempotent upsert into `model_ratings`.

Ratings are reported on an **Elo-like display scale**:
`display = 1000 + (400/ln10)·r`, centred per connected component. A 400-point
gap ≈ 10× expected win odds, matching `P = σ(r_i − r_j)`.

## Layout

```
worker/
  omniarena_rating/
    aggregate.py       # SQL GROUP BY → indexed triples
    bradley_terry.py   # L-BFGS-B fit, Rao-Kupper ties, ridge, anchoring, warm-start
    confidence.py      # Fisher-information CIs + multinomial bootstrap
    connectivity.py    # union-find connected components
    report.py          # fit + CIs + connectivity → Elo-scale records
    writeback.py       # upsert into model_ratings
    __main__.py        # entrypoint (one-shot / --loop)
  tests/               # pure-Python pytest, no database required
  requirements.txt
  Dockerfile
```

## Run

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# One-shot (needs DATABASE_URL and the migrations applied):
DATABASE_URL=postgres://omni_arena:omni_arena@localhost:5432/omni_arena \
  python -m omniarena_rating

# Periodic loop (warm-started refits every REFIT_INTERVAL_SECONDS):
python -m omniarena_rating --loop --interval 300 --ridge 0.01
```

In Docker Compose the `worker` service runs the loop automatically against the
`postgres` service.

## Test

```bash
source .venv/bin/activate
python -m pytest
```

The suite is pure-Python (no live database): it checks the analytic gradient
against finite differences, recovers known synthetic ratings, verifies tie
modelling and anchoring, confirms Fisher CIs agree with the multinomial
bootstrap, and checks connectivity splits a disconnected graph.
