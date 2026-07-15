"""Persist computed ratings back to Postgres (idempotent upsert)."""

from __future__ import annotations

from .report import RatingReport

UPSERT_SQL = """
INSERT INTO model_ratings (
  model_id, rating, rating_stderr, ci_lower, ci_upper,
  component_id, games, computed_at
) VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
ON CONFLICT (model_id) DO UPDATE SET
  rating = EXCLUDED.rating,
  rating_stderr = EXCLUDED.rating_stderr,
  ci_lower = EXCLUDED.ci_lower,
  ci_upper = EXCLUDED.ci_upper,
  component_id = EXCLUDED.component_id,
  games = EXCLUDED.games,
  computed_at = EXCLUDED.computed_at
"""


def write_ratings(conn, report: RatingReport) -> int:
    """Upsert every model rating in one transaction. Returns rows written."""
    rows = [
        (
            m.model_id,
            m.rating,
            m.rating_stderr,
            m.ci_lower,
            m.ci_upper,
            m.component_id,
            m.games,
        )
        for m in report.models
    ]
    with conn.cursor() as cur:
        cur.executemany(UPSERT_SQL, rows)
    conn.commit()
    return len(rows)
