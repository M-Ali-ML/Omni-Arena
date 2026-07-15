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

from .anomaly import SessionStats
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
{exclusion}
GROUP BY model_lo, model_hi
HAVING SUM(CASE WHEN p.vote <> 'skip' THEN 1 ELSE 0 END) > 0
"""

# Excludes sessions flagged by anomaly detection. NULL sessions are always
# kept (we cannot attribute them to an abusive voter).
_EXCLUSION_CLAUSE = (
    "AND (p.anonymous_session_id IS NULL "
    "OR p.anonymous_session_id <> ALL(%s))"
)

MODELS_SQL = """
SELECT id, display_name
FROM models
WHERE enabled = TRUE
ORDER BY created_at, id
"""

# Per-session vote tallies for the pre-fit anomaly screen. Timestamps let the
# speed test run; NULL-session votes cannot be attributed and are ignored.
SESSION_STATS_SQL = """
SELECT
  p.anonymous_session_id AS session_id,
  SUM(CASE WHEN p.vote = 'left' THEN 1 ELSE 0 END)  AS left_votes,
  SUM(CASE WHEN p.vote = 'right' THEN 1 ELSE 0 END) AS right_votes,
  SUM(CASE WHEN p.vote IN ('both_good', 'both_bad') THEN 1 ELSE 0 END) AS ties,
  SUM(CASE WHEN p.vote = 'skip' THEN 1 ELSE 0 END)  AS skips,
  ARRAY_AGG(EXTRACT(EPOCH FROM p.created_at)) AS timestamps
FROM preferences p
WHERE p.anonymous_session_id IS NOT NULL
GROUP BY p.anonymous_session_id
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


def fetch_aggregated_data(
    conn, *, excluded_sessions: list[str] | None = None
) -> AggregatedData:
    """Run the aggregation queries against a psycopg connection.

    ``excluded_sessions`` (from :mod:`omniarena_rating.anomaly`) are dropped from
    the outcome counts before aggregation so spam/malicious voters never reach
    the fit.
    """
    excluded = excluded_sessions or []
    if excluded:
        sql = AGGREGATE_SQL.format(exclusion=_EXCLUSION_CLAUSE)
        params: tuple = (excluded,)
    else:
        sql = AGGREGATE_SQL.format(exclusion="")
        params = ()
    with conn.cursor() as cur:
        cur.execute(MODELS_SQL)
        model_rows = [(str(r[0]), str(r[1])) for r in cur.fetchall()]
        cur.execute(sql, params)
        triple_rows = [
            (str(r[0]), str(r[1]), int(r[2]), int(r[3]), int(r[4]))
            for r in cur.fetchall()
        ]
    return build_aggregated_data(model_rows, triple_rows)


def fetch_session_stats(conn) -> list[SessionStats]:
    """Pull per-session vote tallies for anomaly detection."""
    with conn.cursor() as cur:
        cur.execute(SESSION_STATS_SQL)
        rows = cur.fetchall()
    stats: list[SessionStats] = []
    for session_id, left, right, ties, skips, timestamps in rows:
        stamps = tuple(
            float(t) for t in (timestamps or []) if t is not None
        )
        stats.append(
            SessionStats(
                session_id=str(session_id),
                left=int(left),
                right=int(right),
                ties=int(ties),
                skips=int(skips),
                timestamps=stamps,
            )
        )
    return stats
