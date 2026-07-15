"""Style-controlled Bradley-Terry ratings (joint confounder regression).

Human voters have superficial preferences -- longer answers, heavier markdown,
faster first tokens, and the left-hand slot -- that inflate a model's apparent
strength without reflecting real quality. Rather than filtering these out with a
separate post-hoc regression, OmniArena follows the LMSYS-style approach: the
style features enter the **same** Bradley-Terry logistic regression as extra
covariates, so model strengths and style coefficients are estimated jointly.

For a vote on a matchup whose slot-A model is ``a`` and slot-B model is ``b``,
the latent score difference is::

    d = (r_a - r_b) + beta . x

where ``x`` is the per-vote style-delta vector (slot A minus slot B):

* ``position``   -- a constant 1.0; because orientation is fixed to (A, B) its
                    coefficient is exactly the systematic left-slot advantage;
* ``verbosity``  -- difference in ``output_token_count``;
* ``formatting`` -- difference in ``markdown_density``;
* ``latency_ttft``     -- difference in ``ttft_ms``;
* ``latency_duration`` -- difference in ``stream_duration_ms``.

Ties (``both_good`` / ``both_bad``) are handled with the same Rao-Kupper
threshold ``eta`` used by the style-agnostic fit::

    P(A wins) = sigma(d - eta)
    P(B wins) = sigma(-d - eta)
    P(tie)    = sigma(d + eta) - sigma(d - eta)

A small ridge penalty on **all** coefficients (strengths and style betas) keeps
the joint fit stable when the covariates correlate.

Unlike the default leaderboard, this fit cannot use the O(model pairs)
aggregation from :mod:`omniarena_rating.aggregate` because the style deltas vary
per vote. It therefore operates on raw vote rows and is a heavier, periodic
pass kept separate from the fast default path.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import minimize

from .bradley_terry import _ETA_FLOOR, _log_sigmoid, PairCounts
from .connectivity import connected_components

# Fixed covariate order; ``position`` is the leading constant term.
FEATURE_NAMES: tuple[str, ...] = (
    "position",
    "verbosity",
    "formatting",
    "latency_ttft",
    "latency_duration",
)

_PROB_FLOOR = 1e-12

# Outcome codes.
OUTCOME_A_WINS = 0
OUTCOME_B_WINS = 1
OUTCOME_TIE = 2


@dataclass
class StyleVotes:
    """Raw per-vote design matrix for the style-controlled fit.

    ``a_idx`` / ``b_idx`` are the slot-A / slot-B model indices; ``outcome`` is
    one of :data:`OUTCOME_A_WINS`, :data:`OUTCOME_B_WINS`, :data:`OUTCOME_TIE`;
    ``features`` is an ``(n_votes, n_features)`` matrix of slot-A-minus-slot-B
    style deltas whose first column is the constant position term.
    """

    a_idx: np.ndarray
    b_idx: np.ndarray
    outcome: np.ndarray
    features: np.ndarray
    feature_names: tuple[str, ...] = FEATURE_NAMES

    @property
    def n_votes(self) -> int:
        return int(self.a_idx.size)

    @property
    def n_features(self) -> int:
        return int(self.features.shape[1]) if self.features.size else 0


@dataclass
class StyleFitResult:
    """Result of a joint style-controlled fit (log-odds scale)."""

    ratings: np.ndarray
    tie_param: float
    coefficients: np.ndarray
    feature_names: tuple[str, ...]
    feature_scale: np.ndarray
    n_models: int
    converged: bool
    n_iter: int
    loglik: float
    ridge: float
    raw_params: np.ndarray = field(repr=False)

    @property
    def coefficients_raw_scale(self) -> np.ndarray:
        """Style coefficients expressed per unit of the *original* feature.

        The fit standardises continuous features for conditioning; dividing the
        fitted coefficient by the feature's scale recovers the effect per raw
        unit (per token, per markdown-density point, per millisecond).
        """
        return self.coefficients / self.feature_scale


def _standardise(features: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Z-scale every non-constant column; leave the position column untouched.

    Returns the scaled matrix and the per-column scale factors (1.0 for columns
    that are constant, e.g. the position intercept), so callers can map fitted
    coefficients back to raw units.
    """
    scale = np.ones(features.shape[1], dtype=float)
    scaled = features.astype(float).copy()
    for col in range(features.shape[1]):
        std = float(features[:, col].std())
        if std > 1e-12:
            scale[col] = std
            scaled[:, col] = features[:, col] / std
    return scaled, scale


def _objective_and_grad(
    params: np.ndarray,
    n_models: int,
    a_idx: np.ndarray,
    b_idx: np.ndarray,
    win_a: np.ndarray,
    win_b: np.ndarray,
    tie: np.ndarray,
    features: np.ndarray,
    ridge: float,
) -> tuple[float, np.ndarray]:
    """Penalised negative log-likelihood and analytic gradient (per vote)."""
    r = params[:n_models]
    eta = params[n_models]
    beta = params[n_models + 1 :]

    grad = np.zeros_like(params)

    # Ridge on strengths and style betas, never on the tie threshold.
    nll = 0.5 * ridge * (float(np.dot(r, r)) + float(np.dot(beta, beta)))
    grad[:n_models] += ridge * r
    grad[n_models + 1 :] += ridge * beta

    if a_idx.size:
        d = r[a_idx] - r[b_idx] + features @ beta
        s1 = 1.0 / (1.0 + np.exp(-(d - eta)))
        s2 = 1.0 / (1.0 + np.exp(-(d + eta)))

        log_p_a = _log_sigmoid(d - eta)
        log_p_b = _log_sigmoid(-(d + eta))
        tie_gap = np.clip(s2 - s1, _PROB_FLOOR, None)
        log_p_tie = np.log(tie_gap)

        nll -= float(
            np.dot(win_a, log_p_a)
            + np.dot(win_b, log_p_b)
            + np.dot(tie, log_p_tie)
        )

        tie_d = (s2 * (1.0 - s2) - s1 * (1.0 - s1)) / tie_gap
        tie_e = (s2 * (1.0 - s2) + s1 * (1.0 - s1)) / tie_gap

        # d(log-likelihood)/dd per vote, selected by the observed outcome.
        dll_dd = win_a * (1.0 - s1) - win_b * s2 + tie * tie_d
        dll_de = -win_a * (1.0 - s1) - win_b * s2 + tie * tie_e

        grad_d = -dll_dd  # gradient of the NLL w.r.t. d
        np.add.at(grad, a_idx, grad_d)
        np.add.at(grad, b_idx, -grad_d)
        grad[n_models] += -float(np.sum(dll_de))
        grad[n_models + 1 :] += features.T @ grad_d

    return nll, grad


def fit_style_controlled(
    votes: StyleVotes,
    n_models: int,
    *,
    ridge: float = 0.05,
    max_iter: int = 500,
    init: np.ndarray | None = None,
) -> StyleFitResult:
    """Jointly fit model strengths and style coefficients on raw votes.

    Parameters
    ----------
    votes:
        Per-vote design matrix (:class:`StyleVotes`).
    n_models:
        Number of models; strengths are indexed ``0 .. n_models - 1``.
    ridge:
        Gaussian-prior strength applied to strengths and style betas. Slightly
        larger than the default leaderboard's ridge because the raw-vote fit is
        noisier and the covariates can be collinear.
    """
    if n_models <= 0:
        raise ValueError("n_models must be positive")
    if ridge <= 0:
        raise ValueError("ridge must be positive to keep the fit identified")

    scaled, scale = _standardise(votes.features)
    n_features = votes.n_features

    win_a = (votes.outcome == OUTCOME_A_WINS).astype(float)
    win_b = (votes.outcome == OUTCOME_B_WINS).astype(float)
    tie = (votes.outcome == OUTCOME_TIE).astype(float)

    dim = n_models + 1 + n_features
    if init is not None and init.shape == (dim,):
        x0 = np.array(init, dtype=float)
        x0[n_models] = max(x0[n_models], _ETA_FLOOR)
    else:
        x0 = np.zeros(dim, dtype=float)
        x0[n_models] = 0.5

    bounds = (
        [(None, None)] * n_models
        + [(_ETA_FLOOR, None)]
        + [(None, None)] * n_features
    )

    result = minimize(
        _objective_and_grad,
        x0,
        args=(
            n_models,
            votes.a_idx,
            votes.b_idx,
            win_a,
            win_b,
            tie,
            scaled,
            ridge,
        ),
        method="L-BFGS-B",
        jac=True,
        bounds=bounds,
        options={"maxiter": max_iter, "ftol": 1e-12, "gtol": 1e-8},
    )

    raw_params = result.x.copy()
    ratings = raw_params[:n_models].copy()
    ratings -= ratings.mean()

    return StyleFitResult(
        ratings=ratings,
        tie_param=float(raw_params[n_models]),
        coefficients=raw_params[n_models + 1 :].copy(),
        feature_names=votes.feature_names,
        feature_scale=scale,
        n_models=n_models,
        converged=bool(result.success),
        n_iter=int(result.nit),
        loglik=-float(result.fun),
        ridge=ridge,
        raw_params=raw_params,
    )


def style_pairs(votes: StyleVotes) -> list[PairCounts]:
    """Collapse raw votes into pair counts for connectivity detection only.

    The style fit itself needs the raw rows, but connected-component analysis
    only cares about which model pairs share any comparison edge, so a light
    aggregation is enough here.
    """
    from collections import defaultdict

    counts: dict[tuple[int, int], list[float]] = defaultdict(
        lambda: [0.0, 0.0, 0.0]
    )
    for k in range(votes.n_votes):
        a = int(votes.a_idx[k])
        b = int(votes.b_idx[k])
        i, j = (a, b) if a < b else (b, a)
        outcome = int(votes.outcome[k])
        cell = counts[(i, j)]
        if outcome == OUTCOME_TIE:
            cell[2] += 1.0
        elif (outcome == OUTCOME_A_WINS) == (a < b):
            cell[0] += 1.0
        else:
            cell[1] += 1.0
    return [
        PairCounts(i=i, j=j, wins_i=c[0], wins_j=c[1], ties=c[2])
        for (i, j), c in counts.items()
    ]


def component_labels(votes: StyleVotes, n_models: int) -> list[int]:
    """Connected-component label per model over the style vote graph."""
    return connected_components(n_models, style_pairs(votes))


def _style_gradient(
    params: np.ndarray,
    votes: StyleVotes,
    scaled: np.ndarray,
    win_a: np.ndarray,
    win_b: np.ndarray,
    tie: np.ndarray,
    n_models: int,
    ridge: float,
) -> np.ndarray:
    _, grad = _objective_and_grad(
        params,
        n_models,
        votes.a_idx,
        votes.b_idx,
        win_a,
        win_b,
        tie,
        scaled,
        ridge,
    )
    return grad


def style_rating_stderr(
    result: StyleFitResult,
    votes: StyleVotes,
    *,
    confidence: float = 0.95,
    eps: float = 1e-5,
) -> tuple[np.ndarray, float]:
    """Standard errors for the anchored style-controlled ratings.

    Uses the same observed-Fisher-information (inverse-Hessian) machinery as the
    default leaderboard: difference the analytic gradient to build the Hessian
    of the penalised NLL, invert it, then project through the sum-to-zero anchor
    contrast so the barely-penalised common-mode direction does not dominate.
    Returns ``(stderr_per_model, z)``.
    """
    from scipy.stats import norm

    z = float(norm.ppf(0.5 + confidence / 2.0))
    n = result.n_models
    scaled, _ = _standardise(votes.features)
    win_a = (votes.outcome == OUTCOME_A_WINS).astype(float)
    win_b = (votes.outcome == OUTCOME_B_WINS).astype(float)
    tie = (votes.outcome == OUTCOME_TIE).astype(float)

    params = result.raw_params
    dim = params.size
    hessian = np.zeros((dim, dim))
    for k in range(dim):
        step = np.zeros(dim)
        step[k] = eps
        grad_plus = _style_gradient(
            params + step, votes, scaled, win_a, win_b, tie, n, result.ridge
        )
        grad_minus = _style_gradient(
            params - step, votes, scaled, win_a, win_b, tie, n, result.ridge
        )
        hessian[:, k] = (grad_plus - grad_minus) / (2.0 * eps)
    hessian = 0.5 * (hessian + hessian.T)

    covariance = np.linalg.inv(hessian)[:n, :n]
    contrast = np.eye(n) - np.ones((n, n)) / n
    anchored_cov = contrast @ covariance @ contrast.T
    variances = np.clip(np.diag(anchored_cov), 0.0, None)
    return np.sqrt(variances), z


# --- Database ingestion and display-scale report -------------------------

# Raw vote rows joined to both slot responses. Unlike the default aggregation
# this cannot collapse to pair counts because the style deltas vary per vote.
STYLE_VOTES_SQL = """
SELECT
  mt.slot_a_model_id AS a_id,
  mt.slot_b_model_id AS b_id,
  p.vote,
  ra.output_token_count  AS a_tokens,
  rb.output_token_count  AS b_tokens,
  ra.markdown_density    AS a_md,
  rb.markdown_density    AS b_md,
  ra.ttft_ms             AS a_ttft,
  rb.ttft_ms             AS b_ttft,
  ra.stream_duration_ms  AS a_dur,
  rb.stream_duration_ms  AS b_dur
FROM preferences p
JOIN matchups mt ON mt.id = p.matchup_id
JOIN responses ra ON ra.matchup_id = mt.id AND ra.slot = 'A'
JOIN responses rb ON rb.matchup_id = mt.id AND rb.slot = 'B'
WHERE p.vote <> 'skip'
{exclusion}
"""

_EXCLUSION_CLAUSE = (
    "AND (p.anonymous_session_id IS NULL "
    "OR p.anonymous_session_id <> ALL(%s))"
)

_VOTE_OUTCOME = {
    "left": OUTCOME_A_WINS,
    "right": OUTCOME_B_WINS,
    "both_good": OUTCOME_TIE,
    "both_bad": OUTCOME_TIE,
}


def _num(value) -> float:
    return float(value) if value is not None else 0.0


def build_style_votes(
    index_of: dict[str, int],
    rows: list[tuple],
) -> StyleVotes:
    """Map raw joined vote rows into a :class:`StyleVotes` design matrix.

    Rows whose slot model is disabled/unknown are dropped. Splitting this from
    the DB call keeps the mapping testable without a live database.
    """
    a_idx: list[int] = []
    b_idx: list[int] = []
    outcome: list[int] = []
    features: list[list[float]] = []
    for row in rows:
        a_id, b_id, vote = str(row[0]), str(row[1]), row[2]
        if a_id not in index_of or b_id not in index_of or vote not in _VOTE_OUTCOME:
            continue
        a_tokens, b_tokens = _num(row[3]), _num(row[4])
        a_md, b_md = _num(row[5]), _num(row[6])
        a_ttft, b_ttft = _num(row[7]), _num(row[8])
        a_dur, b_dur = _num(row[9]), _num(row[10])
        a_idx.append(index_of[a_id])
        b_idx.append(index_of[b_id])
        outcome.append(_VOTE_OUTCOME[vote])
        features.append(
            [
                1.0,  # position (constant left-slot term)
                a_tokens - b_tokens,
                a_md - b_md,
                a_ttft - b_ttft,
                a_dur - b_dur,
            ]
        )
    if not a_idx:
        return StyleVotes(
            a_idx=np.empty(0, dtype=np.intp),
            b_idx=np.empty(0, dtype=np.intp),
            outcome=np.empty(0, dtype=np.intp),
            features=np.empty((0, len(FEATURE_NAMES)), dtype=float),
        )
    return StyleVotes(
        a_idx=np.array(a_idx, dtype=np.intp),
        b_idx=np.array(b_idx, dtype=np.intp),
        outcome=np.array(outcome, dtype=np.intp),
        features=np.array(features, dtype=float),
    )


def fetch_style_votes(
    conn,
    index_of: dict[str, int],
    *,
    excluded_sessions: list[str] | None = None,
) -> StyleVotes:
    """Pull raw votes joined to both slot responses for the style fit."""
    excluded = excluded_sessions or []
    if excluded:
        sql = STYLE_VOTES_SQL.format(exclusion=_EXCLUSION_CLAUSE)
        params: tuple = (excluded,)
    else:
        sql = STYLE_VOTES_SQL.format(exclusion="")
        params = ()
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    return build_style_votes(index_of, rows)


@dataclass
class StyleModelRating:
    model_id: str
    display_name: str
    style_controlled_rating: float
    style_controlled_stderr: float
    ci_lower: float
    ci_upper: float
    component_id: int
    games: int


@dataclass
class StyleRatingReport:
    models: list[StyleModelRating]
    tie_param: float
    coefficients: dict[str, float]
    converged: bool
    n_iter: int
    n_votes: int


def compute_style_ratings(
    model_ids: list[str],
    display_names: list[str],
    votes: StyleVotes,
    *,
    ridge: float = 0.05,
    confidence: float = 0.95,
) -> StyleRatingReport | None:
    """End-to-end style-controlled fit mapped to the Elo-like display scale."""
    # Imported here to avoid a module-load cycle with report.py.
    from .report import BASELINE, SCALE, _center_within_components

    n_models = len(model_ids)
    if n_models == 0 or votes.n_votes == 0:
        return None

    result = fit_style_controlled(votes, n_models, ridge=ridge)
    stderr, z = style_rating_stderr(result, votes, confidence=confidence)
    components = component_labels(votes, n_models)
    centered = _center_within_components(result.ratings, components)

    games = [0] * n_models
    for k in range(votes.n_votes):
        games[int(votes.a_idx[k])] += 1
        games[int(votes.b_idx[k])] += 1

    models: list[StyleModelRating] = []
    for idx, model_id in enumerate(model_ids):
        rating = BASELINE + SCALE * centered[idx]
        se = SCALE * float(stderr[idx])
        half = z * se
        models.append(
            StyleModelRating(
                model_id=model_id,
                display_name=display_names[idx],
                style_controlled_rating=rating,
                style_controlled_stderr=se,
                ci_lower=rating - half,
                ci_upper=rating + half,
                component_id=components[idx],
                games=games[idx],
            )
        )
    models.sort(key=lambda m: m.style_controlled_rating, reverse=True)

    coefficients = {
        name: float(result.coefficients[i])
        for i, name in enumerate(result.feature_names)
    }
    return StyleRatingReport(
        models=models,
        tie_param=result.tie_param,
        coefficients=coefficients,
        converged=result.converged,
        n_iter=result.n_iter,
        n_votes=votes.n_votes,
    )
