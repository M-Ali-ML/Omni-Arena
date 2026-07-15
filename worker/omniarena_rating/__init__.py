"""OmniArena Bradley-Terry rating engine.

A standalone Python worker that turns pairwise votes into a principled
leaderboard: Bradley-Terry MLE with Rao-Kupper tie modelling, a weak ridge
prior for identifiability and regularisation, Fisher-information confidence
intervals validated by a multinomial bootstrap, and comparison-graph
connectivity detection (the fast, style-agnostic default path).

Phase 3 adds a heavier periodic pass: a joint style-controlled Bradley-Terry
regression that folds verbosity/formatting/latency/position confounders into
the same logistic fit, plus a p-value based anomaly screen that drops spam or
malicious voting sessions before any fit runs.
"""

from __future__ import annotations

from .aggregate import (
    AggregatedData,
    build_aggregated_data,
    fetch_aggregated_data,
    fetch_session_stats,
)
from .anomaly import (
    AnomalyConfig,
    AnomalyReport,
    SessionStats,
    detect_anomalous_sessions,
)
from .bradley_terry import BTResult, PairCounts, fit_bradley_terry
from .confidence import (
    RatingIntervals,
    bootstrap_stderr,
    fisher_information_intervals,
    multinomial_bootstrap,
)
from .connectivity import connected_components
from .report import ModelRating, RatingReport, compute_ratings
from .style import (
    StyleFitResult,
    StyleRatingReport,
    StyleVotes,
    compute_style_ratings,
    fit_style_controlled,
)

__all__ = [
    "AggregatedData",
    "AnomalyConfig",
    "AnomalyReport",
    "BTResult",
    "ModelRating",
    "PairCounts",
    "RatingIntervals",
    "RatingReport",
    "SessionStats",
    "StyleFitResult",
    "StyleRatingReport",
    "StyleVotes",
    "build_aggregated_data",
    "bootstrap_stderr",
    "compute_ratings",
    "compute_style_ratings",
    "connected_components",
    "detect_anomalous_sessions",
    "fetch_aggregated_data",
    "fetch_session_stats",
    "fisher_information_intervals",
    "fit_bradley_terry",
    "fit_style_controlled",
    "multinomial_bootstrap",
]
