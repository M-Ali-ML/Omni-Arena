import type { PublicArenaEvent } from "../core/events.js";

/**
 * A wire protocol for an arena stream. Each adapter maps the internal
 * PublicArenaEvent sequence onto exactly one transport without the chat route
 * knowing any framing details. Native SSE is the only adapter today; AG-UI,
 * A2UI, Vercel AI SDK, and OpenAI SSE plug in here in later stages by
 * implementing this same port.
 */
export interface EventAdapter {
  /** Response headers this protocol requires before the first chunk. */
  readonly headers: Record<string, string>;
  /** Framed, wire-ready bytes for a single event (schema-validated). */
  serialize(event: PublicArenaEvent): string;
  /** Trailing bytes to flush before the stream closes, if any. */
  finalize(): string;
}
