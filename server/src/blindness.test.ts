import { describe, expect, it } from "vitest";
import type { EventAdapter } from "./adapters/event-adapter.js";
import { PROTOCOL_NAMES, selectAdapter } from "./adapters/registry.js";
import { JoinedRound } from "./arena/join.js";
import { ArenaCore } from "./core/arena.js";
import type { ArenaSlot, PublicArenaEvent } from "./core/events.js";
import { toPublicEvent } from "./core/events.js";
import type {
  ChatMessage,
  Model,
  ModelProviderPort,
  ProviderResolverPort,
} from "./core/ports.js";
import { MockModelProvider, mockVariantTag } from "./providers/mock.js";

/**
 * The product's core invariant: before a vote is cast, nothing the client
 * receives may identify either model. A user who can tell who wrote which
 * answer is no longer expressing a preference between answers, so every vote —
 * and every rating derived from it — is contaminated.
 *
 * These tests are the regression guard. They drive the real provider through the
 * real core and every registered wire adapter, then scan the bytes for anything
 * that names a model. Reintroducing an identity anywhere on the pre-vote path —
 * a provider that greets you by name, an adapter that helpfully labels a slot —
 * fails here.
 *
 * Identities are revealed by the *vote* response (`routes.test.ts`), which is
 * deliberately outside this test's reach.
 */

/** Mirrors the CI/demo roster in `db/seed.mock.ts`. */
const models: Record<"A" | "B", Model> = {
  A: {
    id: "0f1e0f4e-0000-4000-8000-00000000000a",
    displayName: "Mock Model Alpha",
    provider: "mock",
    providerModelId: "mock-alpha",
    enabled: true,
  },
  B: {
    id: "0f1e0f4e-0000-4000-8000-00000000000b",
    displayName: "Mock Model Beta",
    provider: "mock",
    providerModelId: "mock-beta",
    enabled: true,
  },
};

/**
 * Words the two roster entries share, so they single out neither: a slot that
 * says "Mock" has told you only that this is the stub provider.
 */
const GENERIC_WORDS = new Set(["mock", "model"]);

/**
 * Every string that would give a model away, per model: the display name, the
 * row id, the provider model id, and the distinguishing words those names are
 * built from — `Alpha` alone is as much of a tell as the full display name.
 */
function identityTells(model: Model): string[] {
  const words = [
    ...model.displayName.split(/\s+/),
    ...model.providerModelId.split("-"),
  ].filter((word) => !GENERIC_WORDS.has(word.toLowerCase()));
  return [model.displayName, model.id, model.providerModelId, ...words];
}

const tells = [...identityTells(models.A), ...identityTells(models.B)];

function expectNoIdentity(subject: string, what: string): void {
  for (const tell of tells) {
    expect(
      subject.toLowerCase().includes(tell.toLowerCase()),
      `${what} leaks the model identity "${tell}"`,
    ).toBe(false);
  }
}

const messages: ChatMessage[] = [
  { role: "user", content: "Which model are you?" },
];

const resolver: ProviderResolverPort = {
  resolve(): ModelProviderPort {
    return new MockModelProvider();
  },
};

/** The text one slot streams, as the user would read it. */
async function answerText(model: Model): Promise<string> {
  let text = "";
  for await (const chunk of new MockModelProvider().stream(model, messages)) {
    if (chunk.type === "token") {
      text += chunk.token;
    }
  }
  return text;
}

function startedEvent(slots: ArenaSlot[]): PublicArenaEvent {
  return {
    type: "matchup_started",
    matchupId: "9c6a1d2f-0000-4000-8000-0000000000aa",
    matchupToken: "vote-token",
    conversationId: "1a2b3c4d-0000-4000-8000-0000000000bb",
    turnIndex: 0,
    slots,
    mode: "matchup",
    votable: true,
  };
}

/** Everything a client receives for a full matchup, framed by one adapter. */
async function streamBytes(adapter: EventAdapter): Promise<string> {
  const core = new ArenaCore(resolver);
  let body = adapter.serialize(startedEvent(["A", "B"]));
  for await (const event of core.stream(messages, models)) {
    body += adapter.serialize(toPublicEvent(event));
  }
  return body + adapter.finalize();
}

/**
 * Everything the two sibling connections of a *joined* matchup receive. A join
 * splits one matchup across two requests, so it is a second place blindness can
 * be lost — and the split itself must not become the tell: a slot-scoped stream
 * says which slot it is carrying and nothing about who is behind it.
 */
async function joinedStreamBytes(protocol: string): Promise<string> {
  const core = new ArenaCore(resolver);
  const round = new JoinedRound(
    (signal) => core.stream(messages, models, signal),
    async () => {},
  );
  round.start();

  // One adapter per connection, as the route does: each sibling frames its own
  // response.
  const connection = async (slot: ArenaSlot): Promise<string> => {
    const adapter = selectAdapter(protocol, undefined);
    let body = adapter.serialize(startedEvent([slot]));
    for await (const event of round.slot(slot)) {
      body += adapter.serialize(toPublicEvent(event));
    }
    return body + adapter.finalize();
  };

  const [a, b] = await Promise.all([connection("A"), connection("B")]);
  return a + b;
}

describe("pre-vote blindness", () => {
  it("keeps every model identity out of the mock provider's answer", async () => {
    for (const model of Object.values(models)) {
      expectNoIdentity(await answerText(model), "The mock answer");
    }
  });

  it("still lets a test tell the two slots apart", async () => {
    const [a, b] = await Promise.all([
      answerText(models.A),
      answerText(models.B),
    ]);

    expect(a).not.toBe(b);
    expect(a).toContain(`variant ${mockVariantTag("mock-alpha")}`);
    expect(b).toContain(`variant ${mockVariantTag("mock-beta")}`);
    expect(mockVariantTag("mock-alpha")).not.toBe(mockVariantTag("mock-beta"));
  });

  it("derives the variant tag from the model without echoing it", () => {
    const tag = mockVariantTag("gpt-5-turbo-2026-04");

    expect(tag).toMatch(/^[0-9a-f]{4}$/);
    expect(tag).toBe(mockVariantTag("gpt-5-turbo-2026-04"));
    expect(tag).not.toBe(mockVariantTag("gpt-5-turbo-2026-05"));
  });

  // Driven off the registry, so a protocol added later is covered by default
  // rather than by whoever remembers to extend this list.
  it.each(PROTOCOL_NAMES)(
    "keeps every model identity off the wire in a %s matchup stream",
    async (protocol) => {
      const body = await streamBytes(selectAdapter(protocol, undefined));

      expect(body).toContain("Mock answer");
      expectNoIdentity(body, `The ${protocol} stream`);
    },
  );

  it.each(PROTOCOL_NAMES)(
    "keeps every model identity off both siblings of a joined %s matchup",
    async (protocol) => {
      const body = await joinedStreamBytes(protocol);

      expect(body).toContain("Mock answer");
      expectNoIdentity(body, `The joined ${protocol} stream`);
    },
  );
});
