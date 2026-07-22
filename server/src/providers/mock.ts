import type {
  ChatMessage,
  Model,
  ModelProviderPort,
  ModelStreamChunk,
} from "../core/ports.js";

/**
 * Deterministic stub provider for local demos, examples, and CI/e2e: it never
 * touches the network and streams a fixed, per-model set of tokens so an arena
 * round-trip completes without any real LLM API key. Enable it by registering
 * the "mock" provider (see configure.ts, guarded by ARENA_MOCK_PROVIDER) and
 * seeding models with `provider = 'mock'` (see db/seed.mock.ts).
 *
 * The output is a function of the model and the latest user prompt only, so the
 * same inputs always yield the same bytes — the property e2e assertions rely on.
 */
export class MockModelProvider implements ModelProviderPort {
  async *stream(
    model: Model,
    messages: ChatMessage[],
  ): AsyncIterable<ModelStreamChunk> {
    const prompt = messages.at(-1)?.content ?? "";
    const tokens = [
      `Mock reply from ${model.displayName}. `,
      `You said: "${prompt}". `,
      "This canned answer streams token-by-token ",
      "so the arena flow runs end-to-end with no external model.",
    ];

    yield {
      type: "metadata",
      modelVersion: `${model.providerModelId}-mock`,
      outputTokenCount: tokens.length,
    };
    for (const token of tokens) {
      yield { type: "token", token };
    }
  }
}
