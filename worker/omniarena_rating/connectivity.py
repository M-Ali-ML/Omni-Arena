"""Comparison-graph connectivity.

Bradley-Terry ratings are only comparable within a connected component of the
matchup graph: if two sets of models have never been compared (directly or
transitively) their relative rating is undefined. The engine detects the
components with a union-find over the aggregated pairs, so callers can report
per-component leaderboards and mark isolated models.
"""

from __future__ import annotations

from .bradley_terry import PairCounts


class _UnionFind:
    def __init__(self, n: int) -> None:
        self._parent = list(range(n))
        self._rank = [0] * n

    def find(self, x: int) -> int:
        root = x
        while self._parent[root] != root:
            root = self._parent[root]
        # Path compression.
        while self._parent[x] != root:
            self._parent[x], x = root, self._parent[x]
        return root

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self._rank[ra] < self._rank[rb]:
            ra, rb = rb, ra
        self._parent[rb] = ra
        if self._rank[ra] == self._rank[rb]:
            self._rank[ra] += 1


def connected_components(
    n_models: int, pairs: list[PairCounts]
) -> list[int]:
    """Return a component label per model index.

    Only pairs with at least one non-tie or tie outcome (any real comparison)
    create an edge. Labels are assigned densely in ascending order of the
    smallest member index, so the largest/earliest component tends to be 0.
    """
    uf = _UnionFind(n_models)
    for p in pairs:
        if p.wins_i + p.wins_j + p.ties > 0:
            uf.union(p.i, p.j)

    roots = [uf.find(k) for k in range(n_models)]
    label_of_root: dict[int, int] = {}
    labels = [0] * n_models
    for k in range(n_models):
        root = roots[k]
        if root not in label_of_root:
            label_of_root[root] = len(label_of_root)
        labels[k] = label_of_root[root]
    return labels


def component_sizes(labels: list[int]) -> dict[int, int]:
    """Count members per component label."""
    sizes: dict[int, int] = {}
    for label in labels:
        sizes[label] = sizes.get(label, 0) + 1
    return sizes
