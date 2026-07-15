"""Tests for comparison-graph connectivity detection."""

from __future__ import annotations

from omniarena_rating.bradley_terry import PairCounts
from omniarena_rating.connectivity import (
    component_sizes,
    connected_components,
)


def test_single_connected_component():
    pairs = [
        PairCounts(0, 1, 3, 2, 0),
        PairCounts(1, 2, 1, 4, 1),
    ]
    labels = connected_components(3, pairs)
    assert len(set(labels)) == 1


def test_disconnected_graph_splits_into_components():
    # {0,1} compared with each other; {2,3} with each other; no cross edges.
    pairs = [
        PairCounts(0, 1, 5, 3, 1),
        PairCounts(2, 3, 2, 6, 0),
    ]
    labels = connected_components(4, pairs)
    assert labels[0] == labels[1]
    assert labels[2] == labels[3]
    assert labels[0] != labels[2]
    assert component_sizes(labels) == {0: 2, 1: 2}


def test_isolated_model_is_its_own_component():
    pairs = [PairCounts(0, 1, 4, 4, 2)]
    labels = connected_components(3, pairs)  # model 2 never compared
    assert labels[0] == labels[1]
    assert labels[2] != labels[0]
    assert component_sizes(labels)[labels[2]] == 1


def test_empty_pairs_all_isolated():
    labels = connected_components(3, [])
    assert len(set(labels)) == 3


def test_zero_count_pair_creates_no_edge():
    pairs = [PairCounts(0, 1, 0, 0, 0)]
    labels = connected_components(2, pairs)
    assert labels[0] != labels[1]
