"""Tests for mapping SQL rows into indexed aggregated data."""

from __future__ import annotations

from omniarena_rating.aggregate import build_aggregated_data
from omniarena_rating.report import BASELINE, compute_ratings


MODELS = [
    ("11111111-1111-4111-8111-111111111111", "Alpha"),
    ("22222222-2222-4222-8222-222222222222", "Beta"),
    ("33333333-3333-4333-8333-333333333333", "Gamma"),
]


def test_build_maps_ids_and_counts():
    triples = [
        (MODELS[0][0], MODELS[1][0], 6, 3, 1),  # Alpha vs Beta
        (MODELS[1][0], MODELS[2][0], 2, 5, 2),  # Beta vs Gamma
    ]
    data = build_aggregated_data(MODELS, triples)

    assert data.n_models == 3
    assert data.model_ids[0] == MODELS[0][0]
    assert len(data.pairs) == 2
    # games = wins + wins + ties summed over each model's pairs.
    assert data.games[0] == 10  # Alpha: 6+3+1
    assert data.games[1] == 10 + 9  # Beta appears in both pairs
    assert data.games[2] == 9


def test_canonicalises_reversed_pair_orientation():
    # Row lists hi id first; builder must swap so i < j and wins align.
    triples = [(MODELS[1][0], MODELS[0][0], 4, 1, 0)]
    data = build_aggregated_data(MODELS, triples)
    pair = data.pairs[0]
    assert pair.i < pair.j
    assert pair.i == 0 and pair.j == 1
    # wins for the row's first model (Beta, index 1) must move to wins_j.
    assert pair.wins_i == 1.0  # Alpha (index 0)
    assert pair.wins_j == 4.0  # Beta (index 1)


def test_skips_unknown_and_empty_pairs():
    triples = [
        ("99999999-9999-4999-8999-999999999999", MODELS[0][0], 3, 3, 0),
        (MODELS[0][0], MODELS[1][0], 0, 0, 0),
    ]
    data = build_aggregated_data(MODELS, triples)
    assert data.pairs == []


def test_end_to_end_report_orders_by_rating():
    triples = [
        (MODELS[0][0], MODELS[1][0], 90, 10, 5),  # Alpha dominates Beta
        (MODELS[1][0], MODELS[2][0], 60, 40, 5),  # Beta beats Gamma
        (MODELS[0][0], MODELS[2][0], 80, 20, 5),  # Alpha beats Gamma
    ]
    data = build_aggregated_data(MODELS, triples)
    report = compute_ratings(data, ridge=1e-3)

    names = [m.display_name for m in report.models]
    assert names == ["Alpha", "Beta", "Gamma"]
    # All in one component, baseline-centred so ratings straddle BASELINE.
    assert report.models[0].rating > BASELINE > report.models[-1].rating
    assert all(m.component_id == 0 for m in report.models)
    assert report.models[0].ci_upper > report.models[0].ci_lower
