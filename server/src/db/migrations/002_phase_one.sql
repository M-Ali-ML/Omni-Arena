CREATE TABLE conversations (
  id UUID PRIMARY KEY,
  anonymous_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE matchups
  ADD COLUMN harness_version TEXT NOT NULL DEFAULT 'v1';

ALTER TABLE responses
  ADD COLUMN ttft_ms INTEGER,
  ADD COLUMN stream_duration_ms INTEGER,
  ADD COLUMN output_token_count INTEGER,
  ADD COLUMN token_count_source TEXT,
  ADD COLUMN markdown_density DOUBLE PRECISION,
  ADD COLUMN model_version TEXT;

UPDATE responses SET
  stream_duration_ms = latency_ms,
  output_token_count = 0,
  token_count_source = 'estimated',
  markdown_density = 0;

ALTER TABLE responses
  ALTER COLUMN stream_duration_ms SET NOT NULL,
  ALTER COLUMN output_token_count SET NOT NULL,
  ALTER COLUMN token_count_source SET NOT NULL,
  ALTER COLUMN markdown_density SET NOT NULL;

ALTER TABLE responses
  ADD CONSTRAINT responses_ttft_check CHECK (ttft_ms >= 0),
  ADD CONSTRAINT responses_duration_check CHECK (stream_duration_ms >= 0),
  ADD CONSTRAINT responses_token_count_check CHECK (output_token_count >= 0),
  ADD CONSTRAINT responses_token_source_check CHECK (
    token_count_source IN ('provider', 'estimated')
  ),
  ADD CONSTRAINT responses_markdown_density_check CHECK (
    markdown_density >= 0 AND markdown_density <= 1
  );

CREATE TABLE turns (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  matchup_id UUID NOT NULL UNIQUE REFERENCES matchups(id) ON DELETE CASCADE,
  parent_response_id UUID UNIQUE REFERENCES responses(id),
  turn_index INTEGER NOT NULL CHECK (turn_index >= 0),
  prompt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, turn_index),
  CHECK (
    (turn_index = 0 AND parent_response_id IS NULL)
    OR (turn_index > 0 AND parent_response_id IS NOT NULL)
  )
);

INSERT INTO conversations (id, created_at)
SELECT id, created_at FROM matchups;

INSERT INTO turns (
  id, conversation_id, matchup_id, parent_response_id,
  turn_index, prompt, created_at
)
SELECT id, id, id, NULL, 0, prompt, created_at FROM matchups;

CREATE INDEX turns_conversation_idx
  ON turns (conversation_id, turn_index);
