import { mockVariantTag } from "../../server/src/providers/mock.js";

/**
 * The roster `harness/server.ts` seeds. The harness pins its matchmaking RNG, so
 * slot A is always the first entry and slot B the second.
 */
export const ROSTER = {
  A: { providerModelId: "mock-alpha", displayName: "Mock Model Alpha" },
  B: { providerModelId: "mock-beta", displayName: "Mock Model Beta" },
} as const;

/**
 * Matches the identity-free fingerprint the mock provider stamps on one model's
 * answer: `variant <hash of the provider model id>`.
 *
 * Assertions match this fragment rather than the full sentence deliberately. The
 * fingerprint is the mock's contract with its tests (`server/src/blindness.test.ts`
 * pins it), while the prose around it is free to be reworded. Matching a model's
 * display name instead would be worse than brittle: the name's absence from the
 * stream is the pre-vote blindness the arena exists to guarantee.
 */
export function fingerprintOf(providerModelId: string): RegExp {
  return new RegExp(`variant ${mockVariantTag(providerModelId)}\\b`);
}

/** Every display name that a pre-vote payload must not contain. */
export const IDENTITIES = Object.values(ROSTER).map(
  (model) => model.displayName,
);
