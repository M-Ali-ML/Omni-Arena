-- Persisted Bradley-Terry ratings written by the Python worker.
-- One row per model, upserted on every refit. Absent rows mean the worker has
-- not rated that model yet; the leaderboard exposes null rating fields then.
CREATE TABLE model_ratings (
  model_id UUID PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  rating DOUBLE PRECISION NOT NULL,
  rating_stderr DOUBLE PRECISION NOT NULL,
  ci_lower DOUBLE PRECISION NOT NULL,
  ci_upper DOUBLE PRECISION NOT NULL,
  component_id INTEGER NOT NULL,
  games INTEGER NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ci_lower <= ci_upper),
  CHECK (rating_stderr >= 0),
  CHECK (games >= 0)
);
