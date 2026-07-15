"""Bradley-Terry maximum-likelihood rating fit with explicit tie modeling.

The engine models model strengths on a log scale (``r_i = log theta_i``) and
fits them by maximising a convex penalised log-likelihood with a standard
second-order solver (L-BFGS-B via SciPy) -- never hand-rolled gradient descent.

Ties (``both_good`` / ``both_bad``) are modelled with the Rao-Kupper extension
of Bradley-Terry, which is equivalent to a symmetric three-category ordered
logit with thresholds ``+/- eta``:

    P(i beats j) = sigma(d - eta)
    P(j beats i) = sigma(-d - eta)      with d = r_i - r_j, eta >= 0
    P(tie)       = sigma(d + eta) - sigma(d - eta)

A weak ridge prior (Gaussian prior on ``r``) makes the objective strictly
convex. This serves three purposes at once:

* identifiability -- it removes the additive-constant degeneracy of raw BT;
* regularisation -- sparsely-compared models are pulled toward the population
  mean (0) with wide intervals instead of diverging;
* a well-conditioned Hessian so the Fisher-information covariance in
  :mod:`omniarena_rating.confidence` is invertible.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import minimize

# Minimum value for the tie threshold. Kept strictly positive so the tie
# probability sigma(d+eta) - sigma(d-eta) never collapses to exactly zero.
_ETA_FLOOR = 1e-4
# Floor applied inside logarithms to avoid log(0) for pairs with no ties.
_PROB_FLOOR = 1e-12


@dataclass(frozen=True)
class PairCounts:
    """Aggregated outcomes for a single canonical model pair (``i < j``)."""

    i: int
    j: int
    wins_i: float
    wins_j: float
    ties: float


@dataclass
class BTResult:
    """Result of a Bradley-Terry fit.

    ``ratings`` are on the natural log-odds scale, anchored so they sum to zero
    (globally, or per component when the caller re-centres). ``raw_params`` is
    the full optimiser vector ``[r_0, ..., r_{n-1}, eta]`` before anchoring and
    is what warm-starts and the Fisher-information Hessian operate on.
    """

    ratings: np.ndarray
    tie_param: float
    n_models: int
    converged: bool
    n_iter: int
    loglik: float
    ridge: float
    anchor: str
    reference: int | None
    raw_params: np.ndarray = field(repr=False)


def _log_sigmoid(x: np.ndarray) -> np.ndarray:
    """Numerically stable ``log(sigmoid(x))`` = ``-softplus(-x)``."""
    return -np.logaddexp(0.0, -x)


def _pack_pairs(
    pairs: list[PairCounts],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    if not pairs:
        empty_i = np.empty(0, dtype=np.intp)
        empty_f = np.empty(0, dtype=float)
        return empty_i, empty_i, empty_f, empty_f, empty_f
    i = np.fromiter((p.i for p in pairs), dtype=np.intp, count=len(pairs))
    j = np.fromiter((p.j for p in pairs), dtype=np.intp, count=len(pairs))
    wins_i = np.fromiter((p.wins_i for p in pairs), dtype=float, count=len(pairs))
    wins_j = np.fromiter((p.wins_j for p in pairs), dtype=float, count=len(pairs))
    ties = np.fromiter((p.ties for p in pairs), dtype=float, count=len(pairs))
    return i, j, wins_i, wins_j, ties


def _objective_and_grad(
    params: np.ndarray,
    n_models: int,
    i: np.ndarray,
    j: np.ndarray,
    wins_i: np.ndarray,
    wins_j: np.ndarray,
    ties: np.ndarray,
    ridge: float,
) -> tuple[float, np.ndarray]:
    """Penalised negative log-likelihood and its analytic gradient."""
    r = params[:n_models]
    eta = params[n_models]

    grad = np.zeros_like(params)

    # Ridge / Gaussian-prior penalty on ratings (not on the tie threshold).
    nll = 0.5 * ridge * float(np.dot(r, r))
    grad[:n_models] += ridge * r

    if i.size:
        d = r[i] - r[j]
        # s1 = sigma(d - eta), s2 = sigma(d + eta); s2 >= s1 since eta >= 0.
        s1 = 1.0 / (1.0 + np.exp(-(d - eta)))
        s2 = 1.0 / (1.0 + np.exp(-(d + eta)))

        log_p_i = _log_sigmoid(d - eta)  # P(i beats j)
        log_p_j = _log_sigmoid(-(d + eta))  # P(j beats i)
        tie_gap = np.clip(s2 - s1, _PROB_FLOOR, None)
        log_p_tie = np.log(tie_gap)

        nll -= float(
            np.dot(wins_i, log_p_i)
            + np.dot(wins_j, log_p_j)
            + np.dot(ties, log_p_tie)
        )

        # d(log-likelihood)/dd and d(log-likelihood)/d(eta), per pair.
        tie_d = (s2 * (1.0 - s2) - s1 * (1.0 - s1)) / tie_gap
        tie_e = (s2 * (1.0 - s2) + s1 * (1.0 - s1)) / tie_gap

        dll_dd = wins_i * (1.0 - s1) - wins_j * s2 + ties * tie_d
        dll_de = -wins_i * (1.0 - s1) - wins_j * s2 + ties * tie_e

        # Negative log-likelihood gradient; d = r_i - r_j so dd/dr_i = +1.
        grad_d = -dll_dd
        np.add.at(grad, i, grad_d)
        np.add.at(grad, j, -grad_d)
        grad[n_models] += -float(np.sum(dll_de))

    return nll, grad


def fit_bradley_terry(
    n_models: int,
    pairs: list[PairCounts],
    *,
    ridge: float = 0.01,
    anchor: str = "mean",
    reference: int | None = None,
    init: np.ndarray | None = None,
    max_iter: int = 500,
) -> BTResult:
    """Fit ratings from aggregated pair counts.

    Parameters
    ----------
    n_models:
        Number of models; ratings are indexed ``0 .. n_models - 1``.
    pairs:
        Aggregated :class:`PairCounts`, one per canonical ``(i, j)`` pair.
    ridge:
        Strength of the Gaussian prior on ratings. A small positive value keeps
        the fit identified and well-conditioned; larger values regularise more.
    anchor:
        ``"mean"`` centres ratings to sum-to-zero; ``"reference"`` pins the
        model at index ``reference`` to exactly zero.
    reference:
        Reference model index, required when ``anchor == "reference"``.
    init:
        Optional warm-start vector ``[r_0, ..., r_{n-1}, eta]`` (e.g. a previous
        solution) for fast incremental refits.
    max_iter:
        Maximum L-BFGS-B iterations.
    """
    if n_models <= 0:
        raise ValueError("n_models must be positive")
    if ridge <= 0:
        raise ValueError("ridge must be positive to keep the fit identified")
    if anchor not in {"mean", "reference"}:
        raise ValueError(f"unknown anchor mode: {anchor!r}")
    if anchor == "reference" and reference is None:
        raise ValueError("reference index required when anchor='reference'")

    i, j, wins_i, wins_j, ties = _pack_pairs(pairs)

    if init is not None:
        if init.shape != (n_models + 1,):
            raise ValueError("init must have shape (n_models + 1,)")
        x0 = np.array(init, dtype=float)
        x0[n_models] = max(x0[n_models], _ETA_FLOOR)
    else:
        x0 = np.zeros(n_models + 1, dtype=float)
        x0[n_models] = 0.5  # a mild prior that ties exist

    bounds = [(None, None)] * n_models + [(_ETA_FLOOR, None)]

    result = minimize(
        _objective_and_grad,
        x0,
        args=(n_models, i, j, wins_i, wins_j, ties, ridge),
        method="L-BFGS-B",
        jac=True,
        bounds=bounds,
        options={"maxiter": max_iter, "ftol": 1e-12, "gtol": 1e-8},
    )

    raw_params = result.x.copy()
    ratings = raw_params[:n_models].copy()
    if anchor == "mean":
        ratings -= ratings.mean()
    else:
        assert reference is not None
        ratings -= ratings[reference]

    return BTResult(
        ratings=ratings,
        tie_param=float(raw_params[n_models]),
        n_models=n_models,
        converged=bool(result.success),
        n_iter=int(result.nit),
        loglik=-float(result.fun),
        ridge=ridge,
        anchor=anchor,
        reference=reference,
        raw_params=raw_params,
    )


def negative_log_likelihood(
    params: np.ndarray,
    n_models: int,
    pairs: list[PairCounts],
    ridge: float,
) -> float:
    """Penalised NLL at ``params`` -- exposed for tests / gradient checks."""
    i, j, wins_i, wins_j, ties = _pack_pairs(pairs)
    value, _ = _objective_and_grad(
        params, n_models, i, j, wins_i, wins_j, ties, ridge
    )
    return value


def gradient(
    params: np.ndarray,
    n_models: int,
    pairs: list[PairCounts],
    ridge: float,
) -> np.ndarray:
    """Analytic gradient of the penalised NLL -- exposed for gradient checks."""
    i, j, wins_i, wins_j, ties = _pack_pairs(pairs)
    _, grad = _objective_and_grad(
        params, n_models, i, j, wins_i, wins_j, ties, ridge
    )
    return grad
