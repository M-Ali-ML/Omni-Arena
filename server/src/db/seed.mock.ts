import { randomUUID } from "node:crypto";
import { pool } from "./pool.js";

// Seed variant for demos and CI/e2e: two models served by the deterministic
// "mock" provider (see providers/mock.ts). Pair this with
// ARENA_MOCK_PROVIDER=1 so the server can resolve the "mock" provider. It
// disables every other model so matchmaking only ever picks these two.
const models = [
  { displayName: "Mock Model Alpha", providerModelId: "mock-alpha" },
  { displayName: "Mock Model Beta", providerModelId: "mock-beta" },
];

try {
  await pool.query("UPDATE models SET enabled = FALSE");
  for (const model of models) {
    await pool.query(
      `INSERT INTO models (
        id, display_name, provider, provider_model_id, enabled
      ) VALUES ($1, $2, 'mock', $3, TRUE)
      ON CONFLICT (provider, provider_model_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        enabled = EXCLUDED.enabled`,
      [randomUUID(), model.displayName, model.providerModelId],
    );
  }
  console.log(`Seeded ${models.length} mock models`);
} finally {
  await pool.end();
}
