-- Exposure axis: distinguish human-votable blind matchups from silent shadow
-- comparisons (incumbent streamed, challenger persisted, no vote). Default
-- `blind` keeps every pre-existing row on the human-vote path.
ALTER TABLE matchups
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'blind'
  CHECK (mode IN ('blind', 'shadow'));
