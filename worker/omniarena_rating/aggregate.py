"""In-database outcome aggregation (O(votes) -> O(model pairs)).

Raw votes are collapsed into unique ``(model_lo, model_hi, wins_lo, wins_hi,
ties)`` triples with a single ``GROUP BY`` executed inside Postgres. With ``n``
models the fit input is bounded by ~3*C(n, 2) rows regardless of how many
millions of votes exist -- the raw rows never leave the database.

``skip`` votes are excluded. Pair ordering is canonicalised with
``LEAST``/``GREATEST`` so ``(a, b)`` and ``(b, a)`` merge into one triple.
"""

from __future__ import annotations

from dataclasses import dataclass

from .bradley_terry import PairCounts

# ``wins_lo`` counts decisive votes where the lexicographically smaller model id
# won; ``wins_hi`` the larger; ``ties`` covers both_good / both_bad. ``skip`` is
# filtered out entirely. Grouping by the canonical (lo, hi) pair merges the two
# slot orientations of the same matchup pair.
AGGREGATE_SQL = """
SELECT
  LEAST(mt.model_a_id, mt.model_b_id)   AS model_lo,
  GREATEST(mt.model_a_id, mt.model_b_id) AS model_hi,
  SUM(CASE
        WHEN p.vote IN ('left', 'right')
         AND p.winner_model_id = LEAST(mt.model_a_id, mt.model_b_id)
        THEN 1 ELSE 0 END) AS wins_lo,
  SUM(CASE
        WHEN p.vote IN ('left', 'right')
         AND p.winner_model_id = GREATEST(mt.model_a_id, mt.model_b_id)
        THEN 1 ELSE 0 END) AS wins_hi,
  SUM(CASE
        WHEN p.vote IN ('both_good', 'both_bad')
        THEN 1 ELSE 0 END) AS ties
FROM preferences p
JOIN matchups mt ON mt.id = p.matchup_id
WHERE p.vote <> 'skip'
GROUP BY model_lo, model_hi
HAVING SUM(CASE WHEN p.vote <> 'skip' THEN 1 ELSE 0 END) > 0
"""

MODELS_SQL = """
SELECT id, display_name
FROM models
WHERE enabled = TRUE
ORDER BY created_at, id
"""


@dataclass
class AggregatedData:
    """Aggregated comparison data indexed for the fit."""

    model_ids: list[str]
    display_names: list[str]
    pairs: list[PairCounts]
    games: list[int]

    @property
    def n_models(self) -> int:
        return len(self.model_ids)


def build_aggregated_data(
    model_rows: list[tuple[str, str]],
    triple_rows: list[tuple[str, str, int, int, int]],
) -> AggregatedData:
    """Map raw SQL rows into indexed :class:`AggregatedData`.

    ``model_rows`` are ``(id, display_name)``; ``triple_rows`` are
    ``(model_lo, model_hi, wins_lo, wins_hi, ties)``. Splitting this from the DB
    call keeps the numeric core testable without a live database.
    """
    model_ids = [str(row[0]) for row in model_rows]
    display_names = [str(row[1]) for row in model_rows]
    index_of = {model_id: idx for idx, model_id in enumerate(model_ids)}

    games = [0] * len(model_ids)
    pairs: list[PairCounts] = []
    for lo, hi, wins_lo, wins_hi, ties in triple_rows:
        lo_id, hi_id = str(lo), str(hi)
        if lo_id not in index_of or hi_id not in index_of:
            # A disabled/removed model slipped into an old matchup; skip it.
            continue
        i, j = index_of[lo_id], index_of[hi_id]
        # Canonicalise to i < j so pair orientation is deterministic.
        if i > j:
            i, j = j, i
            wins_lo, wins_hi = wins_hi, wins_lo
        total = int(wins_lo) + int(wins_hi) + int(ties)
        if total == 0:
            continue
        pairs.append(
            PairCounts(
                i=i,
                j=j,
                wins_i=float(wins_lo),
                wins_j=float(wins_hi),
                ties=float(ties),
            )
        )
        games[i] += total
        games[j] += total

    return AggregatedData(
        model_ids=model_ids,
        display_names=display_names,
        pairs=pairs,
        games=games,
    )


def fetch_aggregated_data(conn) -> AggregatedData:
    """Run the aggregation queries against a psycopg connection."""
    with conn.cursor() as cur:
        cur.execute(MODELS_SQL)
        model_rows = [(str(r[0]), str(r[1])) for r in cur.fetchall()]
        cur.execute(AGGREGATE_SQL)
        triple_rows = [
            (str(r[0]), str(r[1]), int(r[2]), int(r[3]), int(r[4]))
            for r in cur.fetchall()
        ]
    return build_aggregated_data(model_rows, triple_rows)
