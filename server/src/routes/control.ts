import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MatchupRegistry } from "../control/registry.js";

/**
 * WebSocket control plane (decision record #7, vision §2.1). A bidirectional
 * channel that acts on an in-flight matchup out-of-band from the token stream.
 *
 * Implemented now: `stop` — aborts the `core.stream` for a matchup via the
 * `MatchupRegistry`'s `AbortController`.
 *
 * Extension point (deferred): `steer` — mid-stream user steering. Full steering
 * requires threading a new-instruction channel into the running producers
 * (re-prompting or injecting a system turn), which is heavier than a stop
 * signal. It is stubbed here with a documented negative ack so the wire contract
 * and seam exist; wiring the instruction into `ArenaCore` is the follow-up.
 */
const controlMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stop"), matchupId: z.string().uuid() }),
  z.object({
    type: z.literal("steer"),
    matchupId: z.string().uuid(),
    instruction: z.string().min(1),
  }),
]);

const STEER_DEFERRED_REASON =
  "mid-stream steering is not yet implemented (decision record #7); " +
  "see the extension point in routes/control.ts";

export function registerControlRoute(
  app: FastifyInstance,
  dependencies: { registry: MatchupRegistry },
): void {
  app.get("/api/arena/control", { websocket: true }, (socket) => {
    const send = (payload: Record<string, unknown>): void =>
      socket.send(JSON.stringify(payload));

    socket.on("message", (raw: Buffer) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        send({ type: "error", message: "Invalid JSON control message" });
        return;
      }

      const parsed = controlMessageSchema.safeParse(json);
      if (!parsed.success) {
        send({ type: "error", message: "Unknown or malformed control message" });
        return;
      }

      if (parsed.data.type === "stop") {
        const stopped = dependencies.registry.stop(parsed.data.matchupId);
        send({ type: "stopped", matchupId: parsed.data.matchupId, ok: stopped });
        return;
      }

      send({
        type: "steer_ack",
        matchupId: parsed.data.matchupId,
        accepted: false,
        reason: STEER_DEFERRED_REASON,
      });
    });
  });
}
