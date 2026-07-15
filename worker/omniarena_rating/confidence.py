"""Confidence intervals for Bradley-Terry ratings.

Primary method: **Fisher information**. Under the ridge (Gaussian-prior)
penalty the objective is smooth and strictly convex, so a Laplace approximation
around the optimum gives a posterior covariance equal to the inverse Hessian of
the penalised negative log-likelihood (the observed Fisher information). The
per-model standard errors are the square roots of its diagonal -- one matrix
computation instead of hundreds of refits.

Validation method: a **multinomial bootstrap** drawn directly from the
aggregated triples. It resamples outcome counts from a Multinomial over the
observed proportions and refits (warm-started), confirming the analytic
intervals without ever touching raw vote rows.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .bradley_terry import BTResult, PairCounts, fit_bradley_terry, gradient


@dataclass
class RatingIntervals:
    """Standard errors and normal CIs for each model's rating (log scale)."""

    stderr: np.ndarray
    lower: np.ndarray
    upper: np.ndarray
    z: float


def _observed_information(
    params: np.ndarray,
    n_models: int,
    pairs: list[PairCounts],
    ridge: float,
    eps: float = 1e-5,
) -> np.ndarray:
    """Hessian of the penalised NLL via central differences of the gradient.

    Differencing the analytic gradient keeps the observed-information matrix
    consistent with the objective actually optimised, and costs O(n) gradient
    evaluations rather than a bespoke second-derivative derivation.
    """
    dim = params.size
    hessian = np.zeros((dim, dim))
    for k in range(dim):
        step = np.zeros(dim)
        step[k] = eps
        grad_plus = gradient(params + step, n_models, pairs, ridge)
        grad_minus = gradient(params - step, n_models, pairs, ridge)
        hessian[:, k] = (grad_plus - grad_minus) / (2.0 * eps)
    # Symmetrise to wash out finite-difference asymmetry.
    return 0.5 * (hessian + hessian.T)


def _anchor_contrast(n: int, anchor: str, reference: int | None) -> np.ndarray:
    """Linear map from raw ratings to anchored (identified) ratings.

    Bradley-Terry ratings are only identified up to the chosen anchor, so the
    covariance must be projected through the same contrast used to anchor the
    point estimates. ``mean`` removes the common-mode (sum-to-zero) direction;
    ``reference`` subtracts the reference model's rating.
    """
    if anchor == "reference":
        assert reference is not None
        contrast = np.eye(n)
        contrast[:, reference] -= 1.0
        return contrast
    return np.eye(n) - np.ones((n, n)) / n


def fisher_information_intervals(
    result: BTResult,
    pairs: list[PairCounts],
    *,
    confidence: float = 0.95,
) -> RatingIntervals:
    """Analytic CIs from the inverse Hessian (observed Fisher information).

    The inverse Hessian is the Laplace-approximation covariance of the raw
    parameters. Because ratings are only identified up to the anchor, we project
    this covariance through the anchoring contrast so the reported standard
    errors describe the identified (anchored) ratings -- otherwise the barely
    penalised common-mode direction dominates the diagonal.
    """
    from scipy.stats import norm

    z = float(norm.ppf(0.5 + confidence / 2.0))
    n = result.n_models

    hessian = _observed_information(
        result.raw_params, n, pairs, result.ridge
    )
    covariance = np.linalg.inv(hessian)[:n, :n]
    contrast = _anchor_contrast(n, result.anchor, result.reference)
    anchored_cov = contrast @ covariance @ contrast.T
    variances = np.clip(np.diag(anchored_cov), 0.0, None)
    stderr = np.sqrt(variances)

    return RatingIntervals(
        stderr=stderr,
        lower=result.ratings - z * stderr,
        upper=result.ratings + z * stderr,
        z=z,
    )


def multinomial_bootstrap(
    result: BTResult,
    pairs: list[PairCounts],
    *,
    n_boot: int = 300,
    ridge: float | None = None,
    seed: int | None = None,
) -> np.ndarray:
    """Bootstrap rating draws by resampling the aggregated triples.

    Flattens the aggregated pairs into outcome cells (``wins_i``, ``wins_j``,
    ``ties`` per pair), draws each bootstrap dataset from a single
    ``Multinomial(N, observed_proportions)``, re-aggregates, and refits
    warm-started from the point estimate.

    Returns an ``(n_boot, n_models)`` array of anchored rating draws whose
    column standard deviations validate the analytic standard errors.
    """
    if not pairs:
        return np.zeros((n_boot, result.n_models))

    rng = np.random.default_rng(seed)
    used_ridge = result.ridge if ridge is None else ridge

    counts = np.array(
        [[p.wins_i, p.wins_j, p.ties] for p in pairs], dtype=float
    )
    flat = counts.reshape(-1)
    total = flat.sum()
    if total <= 0:
        return np.tile(result.ratings, (n_boot, 1))
    proportions = flat / total

    draws = np.empty((n_boot, result.n_models))
    warm = result.raw_params
    for b in range(n_boot):
        resampled = rng.multinomial(int(round(total)), proportions)
        resampled = resampled.reshape(counts.shape)
        boot_pairs = [
            PairCounts(
                i=pairs[k].i,
                j=pairs[k].j,
                wins_i=float(resampled[k, 0]),
                wins_j=float(resampled[k, 1]),
                ties=float(resampled[k, 2]),
            )
            for k in range(len(pairs))
        ]
        boot = fit_bradley_terry(
            result.n_models,
            boot_pairs,
            ridge=used_ridge,
            anchor="mean",
            init=warm,
        )
        draws[b] = boot.ratings
    return draws


def bootstrap_stderr(draws: np.ndarray) -> np.ndarray:
    """Column-wise standard deviation of bootstrap rating draws."""
    return draws.std(axis=0, ddof=1)
