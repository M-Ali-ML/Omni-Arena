"""Tests for report assembly: per-component centering, warm state, warnings."""

from __future__ import annotations

import logging

import numpy as np
import pytest

import omniarena_rating.report as report_mod
from omniarena_rating.aggregate import build_aggregated_data
from omniarena_rating.confidence import RatingIntervals
from omniarena_rating.report import BASELINE, compute_ratings

MODELS = [
    ("11111111-1111-4111-8111-111111111111", "Alpha"),
    ("22222222-2222-4222-8222-222222222222", "Beta"),
    ("33333333-3333-4333-8333-333333333333", "Gamma"),
    ("44444444-4444-4444-8444-444444444444", "Delta"),
]

# Two disjoint matchup clusters: {Alpha, Beta} and {Gamma, Delta}.
DISCONNECTED_TRIPLES = [
    (MODELS[0][0], MODELS[1][0], 30, 10, 5),
    (MODELS[2][0], MODELS[3][0], 25, 15, 5),
]


def _warnings(records: list[logging.LogRecord]) -> list[str]:
    return [
        r.getMessage() for r in records if r.levelno == logging.WARNING
    ]


def test_components_are_centered_independently_on_baseline():
    data = build_aggregated_data(MODELS, DISCONNECTED_TRIPLES)
    report = compute_ratings(data, ridge=1e-3)

    by_component: dict[int, list[float]] = {}
    for model in report.models:
        by_component.setdefault(model.component_id, []).append(model.rating)

    assert len(by_component) == 2
    # Each connected component is sum-to-zero anchored, so its display-scale
    # ratings are centred on BASELINE independently of the other component.
    for ratings in by_component.values():
        assert len(ratings) == 2
        assert float(np.mean(ratings)) == pytest.approx(BASELINE, abs=1e-6)


def test_warm_state_is_populated_for_next_refit():
    data = build_aggregated_data(MODELS[:2], [(MODELS[0][0], MODELS[1][0], 8, 2, 1)])
    report = compute_ratings(data, ridge=1e-3)

    assert report.warm_state is not None
    # Full optimiser vector is [r_0 .. r_{n-1}, eta] -> n_models + 1.
    assert report.warm_state.shape == (data.n_models + 1,)


def test_disconnected_graph_emits_warning(pkg_logs):
    data = build_aggregated_data(MODELS, DISCONNECTED_TRIPLES)
    compute_ratings(data, ridge=1e-3)

    assert any("disconnected" in msg for msg in _warnings(pkg_logs))


def test_connected_graph_emits_no_disconnect_warning(pkg_logs):
    triples = [
        (MODELS[0][0], MODELS[1][0], 20, 10, 2),
        (MODELS[1][0], MODELS[2][0], 15, 12, 3),
    ]
    data = build_aggregated_data(MODELS[:3], triples)
    compute_ratings(data, ridge=1e-3)

    assert not any("disconnected" in msg for msg in _warnings(pkg_logs))


def test_non_convergence_emits_warning(pkg_logs, monkeypatch):
    real_fit = report_mod.fit_bradley_terry

    def fit_but_report_not_converged(*args, **kwargs):
        result = real_fit(*args, **kwargs)
        result.converged = False  # BTResult is a mutable dataclass
        return result

    monkeypatch.setattr(report_mod, "fit_bradley_terry", fit_but_report_not_converged)

    data = build_aggregated_data(MODELS[:2], [(MODELS[0][0], MODELS[1][0], 6, 4, 1)])
    compute_ratings(data, ridge=1e-3)

    assert any("did not converge" in msg for msg in _warnings(pkg_logs))


def test_degenerate_standard_error_emits_warning(pkg_logs, monkeypatch):
    def zero_stderr_intervals(result, pairs, *, confidence=0.95):
        n = result.n_models
        stderr = np.zeros(n)  # degenerate: no uncertainty at all
        return RatingIntervals(
            stderr=stderr,
            lower=result.ratings,
            upper=result.ratings,
            z=1.96,
        )

    monkeypatch.setattr(
        report_mod, "fisher_information_intervals", zero_stderr_intervals
    )

    data = build_aggregated_data(MODELS[:2], [(MODELS[0][0], MODELS[1][0], 6, 4, 1)])
    compute_ratings(data, ridge=1e-3)

    assert any("degenerate" in msg for msg in _warnings(pkg_logs))
