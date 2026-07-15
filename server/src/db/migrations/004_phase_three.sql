-- Phase 3: style-controlled ratings written by the heavier periodic worker pass.
--
-- Kept in a sibling table (not merged into model_ratings) because the
-- style-controlled fit is a separate, slower computation over raw votes and may
-- lag or run independently of the fast default leaderboard. A model has a row
-- here only once the style pass has rated it; the leaderboard LEFT JOINs this
-- table and exposes null style fields until then.
CREATE TABLE model_style_ratings (
  model_id UUID PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  style_controlled_rating DOUBLE PRECISION NOT NULL,
  style_controlled_stderr DOUBLE PRECISION NOT NULL,
  style_ci_lower DOUBLE PRECISION NOT NULL,
  style_ci_upper DOUBLE PRECISION NOT NULL,
  component_id INTEGER NOT NULL,
  games INTEGER NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (style_ci_lower <= style_ci_upper),
  CHECK (style_controlled_stderr >= 0),
  CHECK (games >= 0)
);

-- The fitted style-confounder coefficients (one row per feature: position,
-- verbosity, formatting, latency_ttft, latency_duration). Persisted for the
-- rating-methodology docs and the explain-diff view; upserted every style pass.
CREATE TABLE style_control_coefficients (
  feature TEXT PRIMARY KEY,
  coefficient DOUBLE PRECISION NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
