"""Tests for the joint style-controlled Bradley-Terry regression."""

from __future__ import annotations

import numpy as np

from omniarena_rating.bradley_terry import fit_bradley_terry
from omniarena_rating.style import (
    FEATURE_NAMES,
    OUTCOME_A_WINS,
    OUTCOME_B_WINS,
    OUTCOME_TIE,
    StyleVotes,
    fit_style_controlled,
    style_pairs,
    style_rating_stderr,
)


def _make_votes(
    rows: list[tuple[int, int, int, list[float]]],
) -> StyleVotes:
    a_idx = np.array([r[0] for r in rows], dtype=np.intp)
    b_idx = np.array([r[1] for r in rows], dtype=np.intp)
    outcome = np.array([r[2] for r in rows], dtype=np.intp)
    features = np.array([r[3] for r in rows], dtype=float)
    return StyleVotes(
        a_idx=a_idx, b_idx=b_idx, outcome=outcome, features=features
    )


def _verbosity_driven_dataset(
    rng: np.random.Generator, n_votes: int, beta_true: float
) -> StyleVotes:
    """Two equally-skilled models where model 0 tends to be more verbose.

    Token counts come from *overlapping* per-response distributions (model 0
    wordier on average, but model 1 is sometimes longer), so verbosity is not
    collinear with model identity -- the fit can separate the two. Wins are then
    driven purely by the verbosity delta via a logistic style effect, so the
    only real signal is stylistic and true model strengths are equal.
    """
    rows: list[tuple[int, int, int, list[float]]] = []
    for _ in range(n_votes):
        if rng.random() < 0.5:
            slot_a_model, slot_b_model = 0, 1
        else:
            slot_a_model, slot_b_model = 1, 0
        means = {0: 180.0, 1: 120.0}
        tokens = {
            0: float(rng.normal(means[0], 50)),
            1: float(rng.normal(means[1], 50)),
        }
        a_tok, b_tok = tokens[slot_a_model], tokens[slot_b_model]
        delta = a_tok - b_tok
        p_a_wins = 1.0 / (1.0 + np.exp(-beta_true * delta))
        outcome = OUTCOME_A_WINS if rng.random() < p_a_wins else OUTCOME_B_WINS
        features = [1.0, delta, 0.0, 0.0, 0.0]
        rows.append((slot_a_model, slot_b_model, outcome, features))
    return _make_votes(rows)


def test_style_control_shrinks_pure_verbosity_advantage():
    rng = np.random.default_rng(0)
    votes = _verbosity_driven_dataset(rng, n_votes=4000, beta_true=0.02)

    # Style-agnostic fit on the same votes (collapsed to pair counts).
    agnostic = fit_bradley_terry(2, style_pairs(votes), ridge=1e-3)
    agnostic_gap = abs(agnostic.ratings[0] - agnostic.ratings[1])

    controlled = fit_style_controlled(votes, 2, ridge=1e-3)
    controlled_gap = abs(controlled.ratings[0] - controlled.ratings[1])

    # The style-agnostic model credits model 0 with a large strength edge that
    # is really just verbosity; controlling for it must shrink the gap sharply.
    assert agnostic_gap > 0.8
    assert controlled_gap < 0.5 * agnostic_gap

    verbosity = controlled.coefficients[FEATURE_NAMES.index("verbosity")]
    assert verbosity > 0  # wordier answers are favoured


def test_style_control_recovers_true_skill_when_style_is_neutral():
    rng = np.random.default_rng(3)
    true = np.array([1.2, 0.0, -1.2])
    rows: list[tuple[int, int, int, list[float]]] = []
    for _ in range(6000):
        i, j = rng.choice(3, size=2, replace=False)
        if rng.random() < 0.5:
            a, b = int(i), int(j)
        else:
            a, b = int(j), int(i)
        d = true[a] - true[b]
        p_a = 1.0 / (1.0 + np.exp(-d))
        outcome = OUTCOME_A_WINS if rng.random() < p_a else OUTCOME_B_WINS
        rows.append((a, b, outcome, [1.0, 0.0, 0.0, 0.0, 0.0]))
    votes = _make_votes(rows)

    controlled = fit_style_controlled(votes, 3, ridge=1e-3)
    assert controlled.converged
    assert list(np.argsort(-controlled.ratings)) == [0, 1, 2]
    assert np.corrcoef(controlled.ratings, true)[0, 1] > 0.98


def test_position_coefficient_captures_left_slot_bias():
    rng = np.random.default_rng(5)
    rows: list[tuple[int, int, int, list[float]]] = []
    for _ in range(4000):
        if rng.random() < 0.5:
            a, b = 0, 1
        else:
            a, b = 1, 0
        # Slot A (left) wins 75% of the time regardless of model or style.
        outcome = OUTCOME_A_WINS if rng.random() < 0.75 else OUTCOME_B_WINS
        rows.append((a, b, outcome, [1.0, 0.0, 0.0, 0.0, 0.0]))
    votes = _make_votes(rows)

    controlled = fit_style_controlled(votes, 2, ridge=1e-3)
    position = controlled.coefficients[FEATURE_NAMES.index("position")]
    assert position > 0.5  # strong systematic left-slot advantage
    # With the bias absorbed by the intercept, the two models stay near-equal.
    assert abs(controlled.ratings[0] - controlled.ratings[1]) < 0.2


def test_style_stderr_positive_and_brackets_estimate():
    rng = np.random.default_rng(7)
    votes = _verbosity_driven_dataset(rng, n_votes=2000, beta_true=0.02)
    controlled = fit_style_controlled(votes, 2, ridge=1e-2)
    stderr, z = style_rating_stderr(controlled, votes)
    assert np.all(stderr > 0)
    assert z > 1.9


def test_ties_are_modelled():
    rng = np.random.default_rng(9)
    rows: list[tuple[int, int, int, list[float]]] = []
    for _ in range(1500):
        a, b = 0, 1
        roll = rng.random()
        if roll < 0.3:
            outcome = OUTCOME_TIE
        elif roll < 0.65:
            outcome = OUTCOME_A_WINS
        else:
            outcome = OUTCOME_B_WINS
        rows.append((a, b, outcome, [1.0, 0.0, 0.0, 0.0, 0.0]))
    votes = _make_votes(rows)
    controlled = fit_style_controlled(votes, 2, ridge=1e-3)
    assert controlled.tie_param > 0.0
    assert controlled.converged
