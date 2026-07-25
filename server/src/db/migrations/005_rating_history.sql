-- Append-only snapshots of worker-computed ratings, one row per model per
-- refit. model_ratings keeps only the latest fit (upsert), so this table is
-- what makes rating-over-time charts possible. Rows within one worker run
-- share a computed_at (NOW() is stable inside the write transaction).
CREATE TABLE model_rating_history (
  model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  rating DOUBLE PRECISION NOT NULL,
  rating_stderr DOUBLE PRECISION NOT NULL,
  ci_lower DOUBLE PRECISION NOT NULL,
  ci_upper DOUBLE PRECISION NOT NULL,
  component_id INTEGER NOT NULL,
  games INTEGER NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (model_id, computed_at),
  CHECK (ci_lower <= ci_upper),
  CHECK (rating_stderr >= 0),
  CHECK (games >= 0)
);

CREATE INDEX model_rating_history_computed_idx
  ON model_rating_history (computed_at);
