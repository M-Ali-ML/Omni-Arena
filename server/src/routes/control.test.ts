import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { MatchupRegistry } from "../control/registry.js";
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

  it("acks steering as a documented, deferred extension point", async () => {
    const registry = new MatchupRegistry();
    app = await buildApp(registry);

    const socket = await app.injectWS("/api/arena/control");
    socket.send(
      JSON.stringify({
        type: "steer",
        matchupId: MATCHUP_ID,
        instruction: "be more concise",
      }),
    );
    const reply = await nextMessage(socket);

    expect(reply.type).toBe("steer_ack");
    expect(reply.accepted).toBe(false);
    expect(reply.matchupId).toBe(MATCHUP_ID);
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
