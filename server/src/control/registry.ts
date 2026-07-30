/**
 * Tracks in-flight matchup streams so the WebSocket control plane can act on a
 * running generation (decision record #7: stop / steer). The chat route
 * registers an `AbortController` when it starts streaming and releases it when
 * the stream ends; the control plane looks a matchup up by id and aborts or
 * steers it.
 */
export type SteerHandler = (instruction: string) => boolean;

export class MatchupRegistry {
  private readonly controllers = new Map<string, AbortController>();
  private readonly steerHandlers = new Map<string, SteerHandler>();

  /** Begin tracking a matchup; returns the controller whose signal to stream. */
  register(matchupId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(matchupId, controller);
    return controller;
  }

  /**
   * Bind the mid-stream steer handler for a matchup. Called once the core
   * stream is open and can accept abort-and-restart instructions. Replaces any
   * previous handler for the same id.
   */
  bindSteer(matchupId: string, handler: SteerHandler): void {
    if (!this.controllers.has(matchupId)) {
      return;
    }
    this.steerHandlers.set(matchupId, handler);
  }

  /** Stop watching a matchup once its stream has finished (or failed). */
  release(matchupId: string): void {
    this.controllers.delete(matchupId);
    this.steerHandlers.delete(matchupId);
  }

  /**
   * Abort a matchup's stream. Returns false when the matchup is unknown (never
   * started, already finished, or already stopped) so the caller can report it.
   */
  stop(matchupId: string): boolean {
    const controller = this.controllers.get(matchupId);
    if (!controller || controller.signal.aborted) {
      return false;
    }
    controller.abort();
    return true;
  }

  /**
   * Deliver a mid-stream steer instruction to a running matchup. Returns
   * `{ accepted: true }` only when the matchup is live and its core handler
   * accepted the restart; otherwise a negative ack with a reason.
   */
  steer(
    matchupId: string,
    instruction: string,
  ): { accepted: true } | { accepted: false; reason: string } {
    const controller = this.controllers.get(matchupId);
    if (!controller || controller.signal.aborted) {
      return {
        accepted: false,
        reason: "unknown or expired matchup",
      };
    }
    const handler = this.steerHandlers.get(matchupId);
    if (!handler) {
      return {
        accepted: false,
        reason: "matchup is not accepting steer instructions",
      };
    }
    if (!handler(instruction)) {
      return {
        accepted: false,
        reason: "matchup rejected steer (already completing or stopped)",
      };
    }
    return { accepted: true };
  }
}
