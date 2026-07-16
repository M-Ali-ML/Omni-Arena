/**
 * Tracks in-flight matchup streams so the WebSocket control plane can act on a
 * running generation (decision record #7: stop / steer). The chat route
 * registers an `AbortController` when it starts streaming and releases it when
 * the stream ends; the control plane looks a matchup up by id and aborts it.
 */
export class MatchupRegistry {
  private readonly controllers = new Map<string, AbortController>();

  /** Begin tracking a matchup; returns the controller whose signal to stream. */
  register(matchupId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(matchupId, controller);
    return controller;
  }

  /** Stop watching a matchup once its stream has finished (or failed). */
  release(matchupId: string): void {
    this.controllers.delete(matchupId);
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
}
