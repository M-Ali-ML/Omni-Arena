CREATE TABLE IF NOT EXISTS models (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_model_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_model_id)
);

CREATE TABLE IF NOT EXISTS matchups (
  id UUID PRIMARY KEY,
  prompt TEXT NOT NULL,
  model_a_id UUID NOT NULL REFERENCES models(id),
  model_b_id UUID NOT NULL REFERENCES models(id),
  slot_a_model_id UUID NOT NULL REFERENCES models(id),
  slot_b_model_id UUID NOT NULL REFERENCES models(id),
  matchup_token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (model_a_id <> model_b_id),
  CHECK (slot_a_model_id <> slot_b_model_id)
);

CREATE TABLE IF NOT EXISTS responses (
  id UUID PRIMARY KEY,
  matchup_id UUID NOT NULL REFERENCES matchups(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('A', 'B')),
  model_id UUID NOT NULL REFERENCES models(id),
  content TEXT NOT NULL,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (matchup_id, slot)
);

CREATE TABLE IF NOT EXISTS preferences (
  id UUID PRIMARY KEY,
  matchup_id UUID NOT NULL UNIQUE REFERENCES matchups(id) ON DELETE CASCADE,
  vote TEXT NOT NULL CHECK (
    vote IN ('left', 'right', 'both_good', 'both_bad', 'skip')
  ),
  winner_model_id UUID REFERENCES models(id),
  position_bias_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  anonymous_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS preferences_winner_idx
  ON preferences (winner_model_id);
