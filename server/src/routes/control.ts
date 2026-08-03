import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MatchupRegistry } from "../control/registry.js";

/**
 * WebSocket control plane (docs/md/architecture.md §WebSocket control plane). A bidirectional
 * channel that acts on an in-flight matchup out-of-band from the token stream.
 *
 * - `stop` — aborts the matchup via the registry's `AbortController`.
 * - `steer` — abort-and-restart with an operator instruction appended
 *   identically to both slots (see `ArenaCore.stream` + `MatchupRegistry.steer`).
 */
const controlMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stop"), matchupId: z.string().uuid() }),
  z.object({
    type: z.literal("steer"),
    matchupId: z.string().uuid(),
    instruction: z.string().min(1),
  }),
]);

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

      const result = dependencies.registry.steer(
        parsed.data.matchupId,
        parsed.data.instruction,
      );
      if (result.accepted) {
        send({
          type: "steer_ack",
          matchupId: parsed.data.matchupId,
          accepted: true,
        });
        return;
      }
      send({
        type: "steer_ack",
        matchupId: parsed.data.matchupId,
        accepted: false,
        reason: result.reason,
      });
    });
  });
}
