import type { PublicArenaEvent } from "../core/events.js";

/**
 * The egress half of a wire protocol: each adapter maps the internal
 * PublicArenaEvent sequence onto exactly one transport without the chat route
 * knowing any framing details. A protocol that also has a canonical *request*
 * envelope implements the `RequestAdapter` port in `request-adapter.ts`
 * alongside this one; the two are resolved together by `selectProtocol`.
 */
/**
 * Ids a client minted for the run it is starting. Protocols whose contract says
 * a server echoes them (AG-UI's `threadId` / `runId`) use these to correlate
 * the stream with the run the client believes it started; the arena's own ids
 * are unaffected and keep identifying the matchup.
 */
export interface RunCorrelation {
  threadId?: string;
  runId?: string;
}

export interface EventAdapter {
  /** Response headers this protocol requires before the first chunk. */
  readonly headers: Record<string, string>;
  /** Framed, wire-ready bytes for a single event (schema-validated). */
  serialize(event: PublicArenaEvent): string;
  /** Trailing bytes to flush before the stream closes, if any. */
  finalize(): string;
  /**
   * Set when the protocol's clients settle a run on a terminal error *event*
   * and treat a non-2xx response as a transport failure with nothing to render
   * (AG-UI). For those, a failure that happens before streaming starts is
   * delivered in-band at 200 as a `run_error` instead of as a JSON status.
   * Everything else keeps the HTTP status codes documented in `api.md`.
   */
  readonly inBandErrors?: boolean;
  /**
   * Adopt the run ids the client sent, before any event is serialized.
   * Implemented only by protocols whose contract requires the echo.
   */
  correlate?(correlation: RunCorrelation): void;
}
