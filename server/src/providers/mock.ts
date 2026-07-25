import type {
  ChatMessage,
  Model,
  ModelProviderPort,
  ModelStreamChunk,
} from "../core/ports.js";

/**
 * Stable, identity-free tag that lets a test tell one slot's answer from the
 * other's. It is an FNV-1a hash of the provider model id, truncated to four hex
 * digits: a one-way pseudonym, so the answer text distinguishes the two slots
 * without naming either model. Hashing the provider model id rather than the row
 * id survives re-seeding, because ids are regenerated and provider model ids are
 * not.
 */
export function mockVariantTag(providerModelId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < providerModelId.length; index += 1) {
    hash ^= providerModelId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 4);
}

/**
 * Deterministic stub provider for local demos, examples, and CI/e2e: it never
 * touches the network and streams a fixed, per-model set of tokens so an arena
 * round-trip completes without any real LLM API key. Enable it by registering
 * the "mock" provider (see configure.ts, guarded by ARENA_MOCK_PROVIDER) and
 * seeding models with `provider = 'mock'` (see db/seed.mock.ts).
 *
 * The output is a function of the model and the latest user prompt only, so the
 * same inputs always yield the same bytes — the property e2e assertions rely on.
 *
 * Blindness: the answer text must never contain the model's display name,
 * provider, or provider model id. A matchup renders this text before the vote,
 * so any identity in it contaminates the preference it is there to collect —
 * which is why the two slots are told apart by `mockVariantTag` instead of by
 * name. `src/blindness.test.ts` enforces that invariant.
 */
export class MockModelProvider implements ModelProviderPort {
  async *stream(
    model: Model,
    messages: ChatMessage[],
  ): AsyncIterable<ModelStreamChunk> {
    const prompt = messages.at(-1)?.content ?? "";
    const tokens = [
      `Mock answer, variant ${mockVariantTag(model.providerModelId)}. `,
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
