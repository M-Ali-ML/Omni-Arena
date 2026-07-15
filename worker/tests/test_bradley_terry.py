"""Tests for the Bradley-Terry + Rao-Kupper fit."""

from __future__ import annotations

import numpy as np
import pytest
from scipy.optimize import check_grad

from omniarena_rating.bradley_terry import (
    PairCounts,
    fit_bradley_terry,
    gradient,
    negative_log_likelihood,
)


def test_analytic_gradient_matches_finite_differences():
    rng = np.random.default_rng(0)
    n = 4
    pairs = [
        PairCounts(i=0, j=1, wins_i=7, wins_j=3, ties=2),
        PairCounts(i=0, j=2, wins_i=5, wins_j=5, ties=4),
        PairCounts(i=1, j=3, wins_i=2, wins_j=8, ties=1),
        PairCounts(i=2, j=3, wins_i=6, wins_j=1, ties=3),
    ]
    ridge = 0.05

    def func(x):
        return negative_log_likelihood(x, n, pairs, ridge)

    def grad(x):
        return gradient(x, n, pairs, ridge)

    for _ in range(5):
        x = np.concatenate([rng.normal(size=n), [abs(rng.normal()) + 0.2]])
        err = check_grad(func, grad, x)
        assert err < 1e-5, f"gradient mismatch: {err}"


def test_recovers_known_ratings_from_expected_counts(make_expected_pairs):
    true = np.array([1.2, 0.4, -0.3, -1.3])
    true = true - true.mean()
    eta = 0.35
    pairs = make_expected_pairs(true, eta, games_per_pair=5000)

    result = fit_bradley_terry(len(true), pairs, ridge=1e-4, anchor="mean")

    assert result.converged
    assert np.allclose(result.ratings, true, atol=0.05)
    assert result.tie_param == pytest.approx(eta, abs=0.05)


def test_recovers_ranking_from_sampled_counts(make_sampled_pairs):
    rng = np.random.default_rng(7)
    true = np.array([1.5, 0.7, 0.0, -0.7, -1.5])
    eta = 0.3
    pairs = make_sampled_pairs(true, eta, games_per_pair=4000, rng=rng)

    result = fit_bradley_terry(len(true), pairs, ridge=1e-3, anchor="mean")

    # Ranking is fully recovered and estimates are close.
    assert list(np.argsort(-result.ratings)) == list(np.argsort(-true))
    assert np.corrcoef(result.ratings, true)[0, 1] > 0.99


def test_mean_anchor_sums_to_zero(make_expected_pairs):
    true = np.array([0.9, 0.1, -1.0])
    pairs = make_expected_pairs(true, 0.2, games_per_pair=1000)
    result = fit_bradley_terry(len(true), pairs, ridge=1e-3, anchor="mean")
    assert result.ratings.sum() == pytest.approx(0.0, abs=1e-9)


def test_reference_anchor_pins_reference(make_expected_pairs):
    true = np.array([0.9, 0.1, -1.0])
    pairs = make_expected_pairs(true, 0.2, games_per_pair=1000)
    result = fit_bradley_terry(
        len(true), pairs, ridge=1e-3, anchor="reference", reference=1
    )
    assert result.ratings[1] == pytest.approx(0.0, abs=1e-9)


def test_more_ties_raise_tie_parameter():
    # Two evenly-matched models; only the tie fraction differs.
    few_ties = [PairCounts(i=0, j=1, wins_i=45, wins_j=45, ties=10)]
    many_ties = [PairCounts(i=0, j=1, wins_i=20, wins_j=20, ties=60)]
    eta_few = fit_bradley_terry(2, few_ties, ridge=1e-3).tie_param
    eta_many = fit_bradley_terry(2, many_ties, ridge=1e-3).tie_param
    assert eta_many > eta_few


def test_equal_records_give_equal_ratings():
    pairs = [PairCounts(i=0, j=1, wins_i=30, wins_j=30, ties=20)]
    result = fit_bradley_terry(2, pairs, ridge=1e-3)
    assert result.ratings[0] == pytest.approx(result.ratings[1], abs=1e-6)


def test_warm_start_converges_in_fewer_iterations(make_expected_pairs):
    true = np.array([1.0, 0.3, -0.4, -0.9])
    pairs = make_expected_pairs(true, 0.3, games_per_pair=2000)
    cold = fit_bradley_terry(len(true), pairs, ridge=1e-3)
    warm = fit_bradley_terry(len(true), pairs, ridge=1e-3, init=cold.raw_params)
    assert warm.n_iter <= cold.n_iter
    assert np.allclose(warm.ratings, cold.ratings, atol=1e-4)
