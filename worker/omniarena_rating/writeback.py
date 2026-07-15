"""Persist computed ratings back to Postgres (idempotent upsert)."""

from __future__ import annotations

from .report import RatingReport
from .style import StyleRatingReport

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


STYLE_UPSERT_SQL = """
INSERT INTO model_style_ratings (
  model_id, style_controlled_rating, style_controlled_stderr,
  style_ci_lower, style_ci_upper, component_id, games, computed_at
) VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
ON CONFLICT (model_id) DO UPDATE SET
  style_controlled_rating = EXCLUDED.style_controlled_rating,
  style_controlled_stderr = EXCLUDED.style_controlled_stderr,
  style_ci_lower = EXCLUDED.style_ci_lower,
  style_ci_upper = EXCLUDED.style_ci_upper,
  component_id = EXCLUDED.component_id,
  games = EXCLUDED.games,
  computed_at = EXCLUDED.computed_at
"""

STYLE_COEFF_UPSERT_SQL = """
INSERT INTO style_control_coefficients (feature, coefficient, computed_at)
VALUES (%s, %s, NOW())
ON CONFLICT (feature) DO UPDATE SET
  coefficient = EXCLUDED.coefficient,
  computed_at = EXCLUDED.computed_at
"""


def write_style_ratings(conn, report: StyleRatingReport) -> int:
    """Upsert style-controlled ratings and the fitted style coefficients."""
    rating_rows = [
        (
            m.model_id,
            m.style_controlled_rating,
            m.style_controlled_stderr,
            m.ci_lower,
            m.ci_upper,
            m.component_id,
            m.games,
        )
        for m in report.models
    ]
    coeff_rows = [
        (feature, coefficient)
        for feature, coefficient in report.coefficients.items()
    ]
    with conn.cursor() as cur:
        cur.executemany(STYLE_UPSERT_SQL, rating_rows)
        cur.executemany(STYLE_COEFF_UPSERT_SQL, coeff_rows)
    conn.commit()
    return len(rating_rows)
