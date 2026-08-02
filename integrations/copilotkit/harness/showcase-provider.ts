// The provider the documentation screenshots run against.
//
// `npm run screenshots` needs one thing the repo's MockModelProvider cannot give
// it: pace. The stock mock is identity-free, so blindness is not the problem —
// but it yields four tokens with no delay, which leaves no mid-stream moment to
// photograph and no visible difference in speed between the two columns.
//
// So this streams canned, identity-free markdown, word group by word group, at
// a different speed per model. Everything around it is the real thing — real
// matchmaking, real AG-UI adapter, real vote tokens; only the bytes a provider
// would have returned are canned.
import type {
  ChatMessage,
  Model,
  ModelProviderPort,
  ModelStreamChunk,
} from "../../../server/src/core/ports.js";

type Variant = "alpha" | "beta";

interface ScriptedAnswer {
  /** Lower-cased substring of the prompt that selects this answer. */
  match: string;
  alpha: string;
  beta: string;
}

/**
 * The prompts `screenshots/capture.spec.ts` sends, and the answers that make
 * the pair worth comparing: same question, two defensible styles, different
 * lengths — which is what a real matchup looks like and what makes the vote
 * bar mean something.
 */
const SCRIPT: ScriptedAnswer[] = [
  {
    match: "json web token",
    alpha: `A **JSON Web Token** is a signed note the server hands you and then trusts on sight. It has three dot-separated parts:

- **Header** — which algorithm signed it
- **Payload** — the claims: who you are, and when the token expires
- **Signature** — proof the first two were not edited

Because the signature verifies on its own, the API can authenticate a request without looking anything up.`,
    beta: `Think of a JWT as a festival wristband: the gate checks the seal, not a guest list.

The token carries your claims in plain base64 and a signature over them. Anyone can *read* a JWT; nobody can *alter* one without the key. So treat it as tamper-evident, never as secret.

The trade-off is revocation — it stays valid until it expires.`,
  },
  {
    match: "expire",
    alpha: `Keep the access token short-lived — 5 to 15 minutes — and issue a **refresh token** beside it.

1. The access token expires and the API answers with a \`401\`
2. The client posts its refresh token to the refresh endpoint
3. The server returns a new pair and retires the old refresh token

Rotating on every refresh means a stolen token works once, and the reuse tells you it leaked.`,
    beta: `Two clocks, not one: a short expiry on the access token, and a longer server-side record for the refresh token.

Put the refresh token somewhere scripts cannot reach — an \`HttpOnly\` cookie marked \`Secure\` and \`SameSite=Strict\` — and keep it out of local storage.

That server-side record is also where revocation lives, which is the one thing a bare JWT cannot do for you.`,
  },
  {
    match: "checklist",
    alpha: `A short one:

- Hold the **access token** in memory — it should die with the tab
- Keep the **refresh token** in a cookie marked \`HttpOnly\` and \`Secure\`
- Never local storage: any injected script can read it
- Scope that cookie's path to the refresh endpoint alone
- Send it in an \`Authorization\` header, never in a query string — URLs end up in logs`,
    beta: `A short one:

- Hold the access token in memory, scoped to the tab
- Keep the refresh token in a cookie marked \`HttpOnly\`
- Treat local storage as public
- Log the token id, never the token`,
  },
];

const FALLBACK: Pick<ScriptedAnswer, "alpha" | "beta"> = {
  alpha: `Here is the short version, with the reasoning underneath it, and a
worked example at the end if you want to skim to that instead.`,
  beta: `The honest answer is "it depends" — so here are the two cases that
actually come up, and how to tell which one you are in.`,
};

const variantOf = (model: Model): Variant =>
  model.providerModelId.includes("beta") ? "beta" : "alpha";

/**
 * Different rates so a mid-stream screenshot shows two genuinely live columns.
 *
 * Beta finishes *before* alpha (shorter answer + faster pace). CopilotKit's
 * client has historically dropped late slot-B tokens once A ends; finishing B
 * first keeps both columns complete for the vote / reveal shots.
 */
const PACE_MS: Record<Variant, number> = { alpha: 80, beta: 35 };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Split into word groups that keep their trailing whitespace, so markdown survives. */
const chunk = (text: string, wordsPerChunk: number): string[] => {
  const words = text.match(/\S+\s*/g) ?? [];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(""));
  }
  return chunks;
};

export class ShowcaseModelProvider implements ModelProviderPort {
  async *stream(
    model: Model,
    messages: ChatMessage[],
  ): AsyncIterable<ModelStreamChunk> {
    const prompt = (messages.at(-1)?.content ?? "").toLowerCase();
    const variant = variantOf(model);
    const answer =
      SCRIPT.find((entry) => prompt.includes(entry.match)) ?? FALLBACK;
    const chunks = chunk(answer[variant], 3);

    yield {
      type: "metadata",
      modelVersion: `${model.providerModelId}-showcase`,
      outputTokenCount: chunks.length,
    };
    for (const token of chunks) {
      await sleep(PACE_MS[variant]);
      yield { type: "token", token };
    }
  }
};
