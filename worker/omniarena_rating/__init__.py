"""OmniArena Bradley-Terry rating engine (Phase 2, style-agnostic).

A standalone Python worker that turns aggregated pairwise votes into a
principled leaderboard: Bradley-Terry MLE with Rao-Kupper tie modelling,
a weak ridge prior for identifiability and regularisation, Fisher-information
confidence intervals validated by a multinomial bootstrap, and comparison-graph
connectivity detection.
"""

from __future__ import annotations

from .aggregate import AggregatedData, build_aggregated_data, fetch_aggregated_data
from .bradley_terry import BTResult, PairCounts, fit_bradley_terry
from .confidence import (
    RatingIntervals,
    bootstrap_stderr,
    fisher_information_intervals,
    multinomial_bootstrap,
)
from .connectivity import connected_components
from .report import ModelRating, RatingReport, compute_ratings

__all__ = [
    "AggregatedData",
    "BTResult",
    "ModelRating",
    "PairCounts",
    "RatingIntervals",
    "RatingReport",
    "build_aggregated_data",
    "bootstrap_stderr",
    "compute_ratings",
    "connected_components",
    "fetch_aggregated_data",
    "fisher_information_intervals",
    "fit_bradley_terry",
    "multinomial_bootstrap",
]
