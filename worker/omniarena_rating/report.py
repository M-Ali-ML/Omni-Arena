"""Assemble the human-facing rating report from the statistical fit.

Ratings are fit on the natural log-odds scale, then mapped to an Elo-like
display scale for the leaderboard:

    display = BASELINE + SCALE * r      with SCALE = 400 / ln(10)

``SCALE = 400 / ln(10) ~= 173.72`` is the classic Elo constant: a 400-point gap
means the stronger model is expected to win ~10x as often, matching Bradley-
Terry's ``P = sigma(r_i - r_j)``. Standard errors and CI half-widths scale by the
same factor, so intervals stay in display units.

Ratings are anchored (sum-to-zero) *within each connected component* -- offsets
between components are not identified, so each component is centred on its own
mean before the baseline is added.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .aggregate import AggregatedData
from .bradley_terry import BTResult, fit_bradley_terry
from .confidence import RatingIntervals, fisher_information_intervals
from .connectivity import component_sizes, connected_components
from .logging_setup import get_logger

logger = get_logger(__name__)

SCALE = 400.0 / math.log(10.0)
BASELINE = 1000.0


@dataclass
class ModelRating:
    model_id: str
    display_name: str
    rating: float
    rating_stderr: float
    ci_lower: float
    ci_upper: float
    component_id: int
    games: int


@dataclass
class RatingReport:
    models: list[ModelRating]
    tie_param: float
    converged: bool
    n_iter: int
    # Full optimiser vector ([r_0..r_{n-1}, eta]) for warm-starting the next
    # incremental refit. Not persisted; lives only in memory across refits.
    warm_state: np.ndarray | None = None


def _center_within_components(
    ratings: np.ndarray, components: list[int]
) -> np.ndarray:
    """Sum-to-zero anchor each component independently (log scale)."""
    centered = ratings.astype(float).copy()
    labels = np.asarray(components)
    for label in np.unique(labels):
        mask = labels == label
        centered[mask] -= centered[mask].mean()
    return centered


def build_report(
    data: AggregatedData,
    result: BTResult,
    intervals: RatingIntervals,
    components: list[int],
) -> RatingReport:
    """Combine fit, intervals and connectivity into display-scale records."""
    centered = _center_within_components(result.ratings, components)
    models: list[ModelRating] = []
    for idx, model_id in enumerate(data.model_ids):
        rating = BASELINE + SCALE * centered[idx]
        stderr = SCALE * float(intervals.stderr[idx])
        half = intervals.z * stderr
        models.append(
            ModelRating(
                model_id=model_id,
                display_name=data.display_names[idx],
                rating=rating,
                rating_stderr=stderr,
                ci_lower=rating - half,
                ci_upper=rating + half,
                component_id=components[idx],
                games=data.games[idx],
            )
        )
    models.sort(key=lambda m: m.rating, reverse=True)
    return RatingReport(
        models=models,
        tie_param=result.tie_param,
        converged=result.converged,
        n_iter=result.n_iter,
    )


def compute_ratings(
    data: AggregatedData,
    *,
    ridge: float = 0.01,
    confidence: float = 0.95,
    warm_start: np.ndarray | None = None,
) -> RatingReport:
    """End-to-end: fit, Fisher-information CIs, connectivity, display scaling."""
    result = fit_bradley_terry(
        data.n_models,
        data.pairs,
        ridge=ridge,
        anchor="mean",
        init=warm_start,
    )
    if not result.converged:
        logger.warning(
            "Bradley-Terry fit did not converge after %d iterations "
            "(n_models=%d, pairs=%d); ratings may be unreliable.",
            result.n_iter,
            data.n_models,
            len(data.pairs),
        )
    intervals = fisher_information_intervals(
        result, data.pairs, confidence=confidence
    )
    n_degenerate = int(
        np.count_nonzero(~np.isfinite(intervals.stderr))
        + np.count_nonzero(intervals.stderr == 0.0)
    )
    if n_degenerate:
        logger.warning(
            "%d model(s) have a degenerate (zero or non-finite) standard "
            "error; their confidence intervals are not trustworthy.",
            n_degenerate,
        )
    components = connected_components(data.n_models, data.pairs)
    sizes = component_sizes(components)
    if len(sizes) > 1:
        logger.warning(
            "Comparison graph is disconnected: %d components %s. Ratings are "
            "only comparable within a component.",
            len(sizes),
            sorted(sizes.values(), reverse=True),
        )
    report = build_report(data, result, intervals, components)
    report.warm_state = result.raw_params
    return report
