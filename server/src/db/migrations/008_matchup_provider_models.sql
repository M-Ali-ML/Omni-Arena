-- Snapshot the resolved provider model id per display slot at matchup creation
-- so historical rows keep what actually ran if a roster row's provider_model_id
-- is later repointed. Backfill from the current models join, then require NOT NULL.
ALTER TABLE matchups
  ADD COLUMN slot_a_provider_model_id TEXT;
ALTER TABLE matchups
  ADD COLUMN slot_b_provider_model_id TEXT;

UPDATE matchups
SET slot_a_provider_model_id = models.provider_model_id
FROM models
WHERE matchups.slot_a_model_id = models.id;

UPDATE matchups
SET slot_b_provider_model_id = models.provider_model_id
FROM models
WHERE matchups.slot_b_model_id = models.id;

ALTER TABLE matchups
  ALTER COLUMN slot_a_provider_model_id SET NOT NULL;
ALTER TABLE matchups
  ALTER COLUMN slot_b_provider_model_id SET NOT NULL;
