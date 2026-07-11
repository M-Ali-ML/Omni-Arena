import { pool } from "./pool.js";

const models = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    displayName: "Gemini 3.5 Flash",
    providerModelId: "gemini-3.5-flash",
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    displayName: "Gemini 3.1 Flash-Lite",
    providerModelId: "gemini-3.1-flash-lite",
  },
  {
    id: "10000000-0000-4000-8000-000000000003",
    displayName: "Gemini 2.5 Pro",
    providerModelId: "gemini-2.5-pro",
  },
];

try {
  await pool.query("UPDATE models SET enabled = FALSE");
  for (const model of models) {
    await pool.query(
      `INSERT INTO models (
        id, display_name, provider, provider_model_id, enabled
      ) VALUES ($1, $2, 'google', $3, TRUE)
      ON CONFLICT (id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        provider = EXCLUDED.provider,
        provider_model_id = EXCLUDED.provider_model_id,
        enabled = EXCLUDED.enabled`,
      [model.id, model.displayName, model.providerModelId],
    );
  }
  console.log(`Seeded ${models.length} models`);
} finally {
  await pool.end();
}
