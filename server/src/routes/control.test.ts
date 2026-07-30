import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { MatchupRegistry } from "../control/registry.js";
import { ArenaCore } from "../core/arena.js";
import type {
  ChatMessage,
  Model,
  ModelProviderPort,
  ProviderResolverPort,
} from "../core/ports.js";
import { registerControlRoute } from "./control.js";

type InjectedSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

const MATCHUP_ID = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_ID = "22222222-2222-4222-8222-222222222222";

async function buildApp(registry: MatchupRegistry): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(websocket);
  registerControlRoute(app, { registry });
  await app.ready();
  return app;
}

function nextMessage(socket: InjectedSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data: Buffer) =>
      resolve(JSON.parse(data.toString()) as Record<string, unknown>),
    );
  });
}

const model = (id: string): Model => ({
  id,
  displayName: id,
  provider: id,
  providerModelId: id,
  enabled: true,
});

class RecordingProvider implements ModelProviderPort {
  readonly calls: ChatMessage[][] = [];

  async *stream(_model: Model, messages: ChatMessage[]) {
    this.calls.push(messages);
    yield { type: "token" as const, token: "partial" };
    // Hold the first generation open long enough for the control plane to steer.
    if (this.calls.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    yield { type: "token" as const, token: "-done" };
  }
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("control plane WebSocket", () => {
  it("stops an in-flight matchup and reports success", async () => {
    const registry = new MatchupRegistry();
    const controller = registry.register(MATCHUP_ID);
    app = await buildApp(registry);

    const socket = await app.injectWS("/api/arena/control");
    socket.send(JSON.stringify({ type: "stop", matchupId: MATCHUP_ID }));
    const reply = await nextMessage(socket);

    expect(reply).toEqual({ type: "stopped", matchupId: MATCHUP_ID, ok: true });
    expect(controller.signal.aborted).toBe(true);
    socket.close();
  });

  it("reports ok:false for an unknown matchup", async () => {
    const registry = new MatchupRegistry();
    app = await buildApp(registry);

    const socket = await app.injectWS("/api/arena/control");
    socket.send(JSON.stringify({ type: "stop", matchupId: UNKNOWN_ID }));
    const reply = await nextMessage(socket);

    expect(reply).toEqual({ type: "stopped", matchupId: UNKNOWN_ID, ok: false });
    socket.close();
  });

  it("accepts steer on a live matchup and both producers get the same instruction", async () => {
    const providerA = new RecordingProvider();
    const providerB = new RecordingProvider();
    const core = new ArenaCore(
      new (class implements ProviderResolverPort {
        resolve(provider: string): ModelProviderPort {
          return provider === "a" ? providerA : providerB;
        }
      })(),
    );

    const registry = new MatchupRegistry();
    const controller = registry.register(MATCHUP_ID);
    app = await buildApp(registry);

    const instruction = "be more concise";
    const events: Array<{ type: string }> = [];
    const streamDone = (async () => {
      for await (const event of core.stream(
        [{ role: "user", content: "prompt" }],
        { A: model("a"), B: model("b") },
        controller.signal,
        (steer) => registry.bindSteer(MATCHUP_ID, steer),
      )) {
        events.push(event);
      }
    })();

    await waitFor(
      () => providerA.calls.length === 1 && providerB.calls.length === 1,
    );

    const socket = await app.injectWS("/api/arena/control");
    socket.send(
      JSON.stringify({
        type: "steer",
        matchupId: MATCHUP_ID,
        instruction,
      }),
    );
    const reply = await nextMessage(socket);
    expect(reply).toEqual({
      type: "steer_ack",
      matchupId: MATCHUP_ID,
      accepted: true,
    });

    await streamDone;
    socket.close();

    expect(events.some((event) => event.type === "steered")).toBe(true);
    expect(providerA.calls.length).toBe(2);
    expect(providerB.calls.length).toBe(2);
    expect(providerA.calls[1]).toEqual(providerB.calls[1]);
    expect(providerA.calls[1]).toEqual([
      { role: "user", content: "prompt" },
      { role: "system", content: instruction },
    ]);
  });

  it("returns a negative steer_ack for an unknown matchup", async () => {
    const registry = new MatchupRegistry();
    app = await buildApp(registry);

    const socket = await app.injectWS("/api/arena/control");
    socket.send(
      JSON.stringify({
        type: "steer",
        matchupId: UNKNOWN_ID,
        instruction: "be more concise",
      }),
    );
    const reply = await nextMessage(socket);

    expect(reply.type).toBe("steer_ack");
    expect(reply.accepted).toBe(false);
    expect(reply.matchupId).toBe(UNKNOWN_ID);
    expect(typeof reply.reason).toBe("string");
    socket.close();
  });

  it("rejects malformed control messages", async () => {
    const registry = new MatchupRegistry();
    app = await buildApp(registry);

    const socket = await app.injectWS("/api/arena/control");
    socket.send("not json");
    expect((await nextMessage(socket)).type).toBe("error");

    socket.send(JSON.stringify({ type: "stop", matchupId: "not-a-uuid" }));
    expect((await nextMessage(socket)).type).toBe("error");
    socket.close();
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for producers to start");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
