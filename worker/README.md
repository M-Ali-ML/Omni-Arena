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
`postgres` service. The image's default command is `--loop --style`, so both the
default and the style-controlled pass run on every refit; override the service's
`command:` for a one-shot or default-only run.

### Tuning knobs

Every flag has an environment-variable default, so the same binary is
configurable from `.env` / Compose without changing the command:

| Flag | Env var | Default | What it does |
|---|---|---|---|
| `--interval` | `REFIT_INTERVAL_SECONDS` | `300` | Seconds between refits in loop mode. |
| `--full-refit-every` | `FULL_REFIT_EVERY` | `12` | Refits between from-scratch (cold) fits; `0` warm-starts indefinitely. |
| `--ridge` | `RATING_RIDGE` | `0.01` | Ridge-prior strength for the main fit (log-odds scale). |
| `--style-ridge` | `STYLE_RIDGE` | `0.05` | Ridge-prior strength for the style-controlled fit. |
| `--style` | — | off (on in the image's default command) | Also run the heavier style-controlled pass on raw votes. |
| `--no-anomaly-filter` | — | on | Skip the pre-fit anomaly screen (keep every session). |
| — | `LOG_LEVEL` / `LOG_FORMAT` | `INFO` / `text` | Verbosity and `text` vs structured `json` output. |

### Incremental refits vs the ground-truth pass

In loop mode most refits are **incremental**: the solver starts from the
previous solution and converges in a handful of L-BFGS-B iterations. Every
`FULL_REFIT_EVERY` refits the warm state is dropped and the fit runs **from
scratch** — an hour apart at the default interval, cheap because the fit input is
bounded by model pairs rather than vote volume. The loop's first refit is already
cold (there is no warm state yet), so the forced passes land on refits 1, 13, 25…
rather than one iteration early. Each refit logs `mode=full` or
`mode=incremental`.

The ridge makes the objective strictly convex, so both paths share one unique
optimum. The cold pass exploits that: it re-runs the warm path over the *same*
aggregates and warns when the two land more than half a standard error apart,
which catches an incremental chain that has stopped short of the optimum. Holding
the data fixed is what makes this a solver check rather than a measurement of the
rating movement new votes would have caused anyway.

## Test

```bash
source .venv/bin/activate
python -m pytest
```

The suite is pure-Python (no live database): it checks the analytic gradient
against finite differences, recovers known synthetic ratings, verifies tie
modelling and anchoring, confirms Fisher CIs agree with the multinomial
bootstrap, and checks connectivity splits a disconnected graph.
