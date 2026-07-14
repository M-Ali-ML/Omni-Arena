import { randomUUID } from "node:crypto";
import { pool } from "./pool.js";

const models = [
  {
    displayName: "Gemini 3.1 Flash-Lite",
    providerModelId: "gemini-3.1-flash-lite",
  },
  {
    displayName: "Gemini 3 Flash",
    providerModelId: "gemini-3-flash-preview",
  },
  {
    displayName: "Gemini 3.5 Flash",
    providerModelId: "gemini-3.5-flash",
  },
];

try {
  await pool.query("UPDATE models SET enabled = FALSE");
  for (const model of models) {
    await pool.query(
      `INSERT INTO models (
        id, display_name, provider, provider_model_id, enabled
      ) VALUES ($1, $2, 'google', $3, TRUE)
      ON CONFLICT (provider, provider_model_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        enabled = EXCLUDED.enabled`,
      [randomUUID(), model.displayName, model.providerModelId],
    );
  }
  console.log(`Seeded ${models.length} models`);
} finally {
  await pool.end();
}
