// The OmniArena service used for the documentation screenshots.
//
// Same real Fastify app, pg-mem repository and matchmaking as the e2e harness
// (`harness/arena.ts`), with one difference: the stub provider streams prose
// worth putting in a screenshot, word by word at human speed, instead of the
// single-line canned reply `server/src/providers/mock.ts` emits. That buys two
// things the docs need and the e2e mock cannot give:
//
//   * a genuine mid-stream frame — the built-in mock finishes in milliseconds;
//   * two visibly *different* answers, so the blind comparison reads as a
//     comparison rather than as the same sentence twice.
//
// The models are still called "Mock Model Alpha"/"Mock Model Beta": no real
// provider is contacted and no key is used, and the screenshots should not
// pretend otherwise.
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { createApp } from "../../../../server/src/app.js";
import { ArenaCore } from "../../../../server/src/core/arena.js";
import type {
  ChatMessage,
  Model,
  ModelProviderPort,
  ModelStreamChunk,
} from "../../../../server/src/core/ports.js";
import { runMigrations } from "../../../../server/src/db/migrations.js";
import { RandomMatchmaker } from "../../../../server/src/matchmaking/random.js";
import { ProviderRegistry } from "../../../../server/src/providers/registry.js";
import { PostgresRepository } from "../../../../server/src/repo/postgres.js";
import { MatchupTokenService } from "../../../../server/src/token.js";

const MOCK_ALPHA = "00000000-0000-4000-8000-000000000a1a";
const MOCK_BETA = "00000000-0000-4000-8000-000000000b2b";

/**
 * Answers keyed by the prompt the screenshot script sends, then by model, so
 * each capture shows two answers that actually address the question and differ
 * from each other in length and formatting — the thing a blind comparison is
 * for. First matching pattern wins.
 */
const SCRIPT: Array<{ match: RegExp; answers: Record<string, string> }> = [
  {
    answers: {
      "mock-alpha":
        "A JSON Web Token is a signed, self-contained credential: a JSON " +
        "payload plus a signature the receiver can verify without a database " +
        "lookup. That is exactly why you should **not** use one for a " +
        "long-lived login session — a token stays valid until it expires, so " +
        "a sign-out or a permission change cannot take effect until then. " +
        "Reach for a session you can revoke instead, and keep JWTs for " +
        "short-lived, service-to-service hops.",
      "mock-beta":
        "**What it is.** A JWT packs claims into JSON, base64-encodes them, " +
        "and signs the result, so any holder of the key can check it " +
        "offline.\n\n**When to skip it.**\n\n" +
        "- Sessions you may need to revoke — logout and role changes do not " +
        "propagate.\n" +
        "- Anything secret: the payload is encoded, not encrypted.\n" +
        "- Large claim sets, which every request then has to carry.",
    },
    match: /json web token/i,
  },
  {
    answers: {
      "mock-alpha":
        "A JWT is a signed slip of JSON that proves who you are without the " +
        "server having to look you up. Avoid it for login sessions, because " +
        "you cannot take one back before it expires.",
      "mock-beta":
        "A JWT is a tamper-evident JSON payload a server validates with a key " +
        "instead of a lookup. Skip it wherever access has to be revocable on " +
        "the spot — a valid token cannot be recalled.",
    },
    match: /two sentences|junior/i,
  },
  {
    answers: {
      "mock-alpha":
        "1. Publish the new public key alongside the old one and give " +
        "verifiers time to pick it up.\n" +
        "2. Switch signing to the new key, keeping the old one accepted.\n" +
        "3. Wait out the longest token lifetime, then retire the old key and " +
        "remove it from the key set.",
    },
    match: /rotating a signing key|rotate/i,
  },
];

const FALLBACK =
  "This is the OmniArena screenshot harness: a deterministic stub provider " +
  "standing in for a real model, so the docs can be regenerated without an " +
  "API key.";

/** Rough per-model pacing, so the two columns visibly stream at different speeds. */
const DELAY_MS: Record<string, number> = { "mock-alpha": 34, "mock-beta": 46 };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class DemoModelProvider implements ModelProviderPort {
  async *stream(
    model: Model,
    messages: ChatMessage[],
  ): AsyncIterable<ModelStreamChunk> {
    const prompt = messages.at(-1)?.content ?? "";
    const entry = SCRIPT.find((candidate) => candidate.match.test(prompt));
    const answer = entry?.answers[model.providerModelId] ?? FALLBACK;
    // Word-by-word, whitespace kept on the token, so partial markdown never
    // renders as a broken half-word in the mid-stream screenshot.
    const tokens = answer.split(/(?<=\s)/);
    const delay = DELAY_MS[model.providerModelId] ?? 40;

    yield {
      type: "metadata",
      modelVersion: `${model.providerModelId}-demo`,
      outputTokenCount: tokens.length,
    };
    for (const token of tokens) {
      await sleep(delay);
      yield { type: "token", token };
    }
  }
}

const database = newDb();
const adapter = database.adapters.createPg();
const pool = new adapter.Pool() as unknown as Pool;

await runMigrations(pool);
await pool.query(
  `INSERT INTO models (
    id, display_name, provider, provider_model_id, enabled
  ) VALUES
    ($1, 'Mock Model Alpha', 'mock', 'mock-alpha', TRUE),
    ($2, 'Mock Model Beta', 'mock', 'mock-beta', TRUE)`,
  [MOCK_ALPHA, MOCK_BETA],
);

const repository = new PostgresRepository(pool);
const app = await createApp({
  core: new ArenaCore(
    new ProviderRegistry().register("mock", new DemoModelProvider()),
  ),
  // Fixed RNG: slot A is always Mock Model Alpha, so the captions can name it.
  matchmaker: new RandomMatchmaker(repository, () => 0.1),
  repository,
  tokens: new MatchupTokenService("screenshots-matchup-secret-long-enough"),
  harnessVersion: "screenshots",
  // `manual` so the same server can serve both a blind matchup (Compare: on)
  // and the single, non-votable round the last screenshot shows.
  modeConfig: { defaultModel: MOCK_ALPHA, trigger: "manual" },
  logger: false,
});

const port = Number(process.env.SCREENSHOT_ARENA_PORT ?? 3401);
await app.listen({ host: "127.0.0.1", port });
console.log(`OmniArena screenshot harness listening on http://127.0.0.1:${port}`);

const shutdown = (): void => {
  void app.close().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
