import type { FastifyInstance } from "fastify";
import type { PreferenceRepositoryPort } from "../core/ports.js";

/**
 * OpenAI-compatible model list. Every OpenAI client's first call is
 * `GET {base}/models` — Open WebUI treats it as the connection check and builds
 * its model picker from it — so without this route the OpenAI adapter is
 * undiscoverable no matter how well-formed its stream is.
 *
 * Both `/models` and `/v1/models` are served because a deployment may be
 * configured with the arena origin either with or without the `/v1` prefix.
 * The roster is not secret (the leaderboard already names every model); what
 * stays blind is which two models a given matchup drew.
 */
export const OPENAI_MODEL_LIST_PATHS = ["/models", "/v1/models"];

export function registerModelsRoute(
  app: FastifyInstance,
  repository: PreferenceRepositoryPort,
): void {
  // OpenAI's model object carries a creation timestamp the arena's roster has
  // no equivalent for; boot time is the closest true statement.
  const created = Math.floor(Date.now() / 1000);

  const handler = async () => {
    const models = await repository.listEnabledModels();
    return {
      object: "list",
      data: models.map((model) => ({
        id: model.id,
        object: "model",
        created,
        owned_by: model.provider,
        // Not part of OpenAI's model object, but read by several
        // OpenAI-compatible UIs to label the picker; a strict client ignores it.
        name: model.displayName,
      })),
    };
  };

  for (const path of OPENAI_MODEL_LIST_PATHS) {
    app.get(path, handler);
  }
}
