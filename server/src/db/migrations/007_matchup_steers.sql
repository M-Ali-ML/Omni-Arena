-- Mid-stream steer instructions recorded for later analysis / style control.
-- Appended as a JSON array of { instruction, at } objects by recordSteer().
ALTER TABLE matchups
  ADD COLUMN steers JSONB NOT NULL DEFAULT '[]'::jsonb;
