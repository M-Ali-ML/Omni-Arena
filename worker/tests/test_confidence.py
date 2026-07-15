"""Tests for Fisher-information CIs and the multinomial bootstrap."""

from __future__ import annotations

import numpy as np

from omniarena_rating.bradley_terry import PairCounts, fit_bradley_terry
from omniarena_rating.confidence import (
    bootstrap_stderr,
    fisher_information_intervals,
    multinomial_bootstrap,
)


def _dataset(rng, games):
    true = np.array([1.0, 0.4, -0.4, -1.0])
    pairs = []
    for i in range(len(true)):
        for j in range(i + 1, len(true)):
            diff = true[i] - true[j]
            p_i = 1.0 / (1.0 + np.exp(-(diff - 0.3)))
            p_j = 1.0 / (1.0 + np.exp(-(-(diff + 0.3))))
            draw = rng.multinomial(games, [p_i, p_j, 1 - p_i - p_j])
            pairs.append(
                PairCounts(i, j, float(draw[0]), float(draw[1]), float(draw[2]))
            )
    return true, pairs


def test_fisher_intervals_bracket_estimate():
    rng = np.random.default_rng(1)
    _, pairs = _dataset(rng, games=2000)
    result = fit_bradley_terry(4, pairs, ridge=1e-3)
    intervals = fisher_information_intervals(result, pairs)

    assert np.all(intervals.stderr > 0)
    assert np.all(intervals.lower < result.ratings)
    assert np.all(intervals.upper > result.ratings)


def test_fisher_agrees_with_multinomial_bootstrap():
    rng = np.random.default_rng(2)
    _, pairs = _dataset(rng, games=1500)
    result = fit_bradley_terry(4, pairs, ridge=1e-3)

    fisher = fisher_information_intervals(result, pairs).stderr
    draws = multinomial_bootstrap(result, pairs, n_boot=400, seed=123)
    boot = bootstrap_stderr(draws)

    # The analytic and resampling standard errors should agree closely.
    assert np.allclose(fisher, boot, rtol=0.25, atol=0.02)


def test_fewer_games_widen_intervals():
    rng = np.random.default_rng(3)
    _, dense = _dataset(rng, games=4000)
    _, sparse = _dataset(rng, games=200)
    se_dense = fisher_information_intervals(
        fit_bradley_terry(4, dense, ridge=1e-3), dense
    ).stderr
    se_sparse = fisher_information_intervals(
        fit_bradley_terry(4, sparse, ridge=1e-3), sparse
    ).stderr
    assert se_sparse.mean() > se_dense.mean()
