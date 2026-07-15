"""Shared test helpers: synthetic Rao-Kupper data generation."""

from __future__ import annotations

import logging
import os
import sys

import numpy as np
import pytest

# Make the worker package importable regardless of how pytest is invoked.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from omniarena_rating.bradley_terry import PairCounts  # noqa: E402


class _ListHandler(logging.Handler):
    """Collect emitted records in memory for assertions."""

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


@pytest.fixture
def pkg_logs():
    """Capture ``omniarena_rating`` log records (including child loggers).

    The package logger has ``propagate=False`` so pytest's ``caplog`` (which
    attaches to the root logger) never sees these records; attaching directly to
    the package logger captures them regardless.
    """
    logger = logging.getLogger("omniarena_rating")
    handler = _ListHandler()
    prev_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    try:
        yield handler.records
    finally:
        logger.removeHandler(handler)
        logger.setLevel(prev_level)


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + np.exp(-x))


def rao_kupper_probs(diff: float, eta: float) -> tuple[float, float, float]:
    """Return (P(i wins), P(j wins), P(tie)) under Rao-Kupper."""
    p_i = _sigmoid(diff - eta)
    p_j = _sigmoid(-(diff + eta))
    return p_i, p_j, 1.0 - p_i - p_j


def expected_pairs(
    ratings: np.ndarray, eta: float, games_per_pair: int
) -> list[PairCounts]:
    """Deterministic expected counts for every pair (noise-free MLE target)."""
    n = len(ratings)
    pairs: list[PairCounts] = []
    for i in range(n):
        for j in range(i + 1, n):
            p_i, p_j, p_t = rao_kupper_probs(ratings[i] - ratings[j], eta)
            pairs.append(
                PairCounts(
                    i=i,
                    j=j,
                    wins_i=p_i * games_per_pair,
                    wins_j=p_j * games_per_pair,
                    ties=p_t * games_per_pair,
                )
            )
    return pairs


def sampled_pairs(
    ratings: np.ndarray,
    eta: float,
    games_per_pair: int,
    rng: np.random.Generator,
) -> list[PairCounts]:
    """Randomly sampled counts for every pair."""
    n = len(ratings)
    pairs: list[PairCounts] = []
    for i in range(n):
        for j in range(i + 1, n):
            probs = rao_kupper_probs(ratings[i] - ratings[j], eta)
            draw = rng.multinomial(games_per_pair, probs)
            pairs.append(
                PairCounts(
                    i=i,
                    j=j,
                    wins_i=float(draw[0]),
                    wins_j=float(draw[1]),
                    ties=float(draw[2]),
                )
            )
    return pairs


@pytest.fixture
def make_expected_pairs():
    return expected_pairs


@pytest.fixture
def make_sampled_pairs():
    return sampled_pairs
