import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ArenaEvent, ArenaSlot } from "../core/events.js";

/**
 * Slot join: serving **one** matchup over **two** sibling HTTP requests.
 *
 * Real chat UIs with a compare view fan a multi-model turn out into one request
 * per model sharing a conversation identifier — Open WebUI v0.10 is the measured
 * case (`integrations/open-webui/`, which had to pair them in a bridge). Each of
 * those requests carries exactly one answer channel, so the arena's default
 * shape (both slots interleaved on one connection) cannot serve them: it either
 * garbles the answers together or produces two unrelated matchups and two
 * half-votes.
 *
 * A join fixes that server-side. Two requests that resolve to the same *scope*
 * within a short window become one matchup: the first claims slot A, the second
 * slot B, each streams its own slot over its own connection, and there is one
 * matchup row and one vote. Everything else — matchmaking, blindness, the
 * conversation, persistence — happens exactly once, on the leader's path, so the
 * arena's semantics are not duplicated here.
 */

export const DEFAULT_JOIN_WINDOW_MS = 2_000;
export const DEFAULT_JOIN_MAX_PENDING = 256;
/**
 * Per-connection event backlog. Only reachable when a paired client reads its
 * own slot slower than the model produces it; a *disconnected* client does not
 * accumulate, because writes to a destroyed socket return immediately.
 */
export const DEFAULT_JOIN_MAX_QUEUED_EVENTS = 4_096;
/**
 * How long a paired sibling waits for the leader to publish the matchup. The
 * leader only has to read the conversation, pick a pair, and insert a row
 * before publishing, so this is a safety net against a leader that dies in a
 * way its own error handling does not cover — never a normal outcome.
 */
export const JOIN_PUBLISH_DEADLINE_MS = 30_000;

const joinConfigSchema = z.object({
  /** Rendezvous window. `0` disables joining: `joinKey` is then ignored. */
  windowMs: z.coerce
    .number()
    .int()
    .min(0)
    .max(60_000)
    .default(DEFAULT_JOIN_WINDOW_MS),
  /** Hard cap on unpaired scopes held in memory. */
  maxPending: z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(DEFAULT_JOIN_MAX_PENDING),
  /**
   * Per-connection event backlog. The floor leaves room for a slot's terminal
   * frames plus a few tokens, below which an ordinarily-paced consumer would
   * trip the overflow; the ceiling is what keeps a stalled consumer from
   * turning into unbounded memory.
   */
  maxQueuedEvents: z.coerce
    .number()
    .int()
    .min(16)
    .max(1_000_000)
    .default(DEFAULT_JOIN_MAX_QUEUED_EVENTS),
});

export type JoinConfig = z.infer<typeof joinConfigSchema>;

export function parseJoinConfig(
  env: Record<string, string | undefined>,
): JoinConfig {
  return joinConfigSchema.parse({
    windowMs: env.ARENA_JOIN_WINDOW_MS,
    maxPending: env.ARENA_JOIN_MAX_PENDING,
    maxQueuedEvents: env.ARENA_JOIN_MAX_QUEUED_EVENTS,
  });
}

/**
 * Everything a join is scoped to. The `joinKey` alone is *not* the capability:
 * it is only the correlation id a client already has (Open WebUI's `chat_id`).
 * Authority comes from the whole tuple — the anonymous session, the turn's
 * conversation, and the exact prompt — which is strictly more than the session
 * id that already gates conversation access.
 */
export interface JoinScope {
  joinKey: string;
  sessionId: string;
  conversationId: string | null;
  prompt: string;
}

/** What the leader hands its sibling once the shared matchup exists. */
export interface JoinHandshake {
  matchupId: string;
  matchupToken: string;
  conversationId: string;
  turnIndex: number;
}

/**
 * A pre-stream failure on the leader's path (a 404 conversation, a write
 * conflict), forwarded so the sibling reports the same thing rather than
 * hanging until its own window closes.
 */
export interface JoinFailure {
  status: number;
  code: string;
  message: string;
}

export class JoinFailureError extends Error {
  constructor(readonly failure: JoinFailure) {
    super(failure.message);
    this.name = "JoinFailureError";
  }
}

export function asJoinFailure(error: unknown): JoinFailure {
  if (error instanceof JoinFailureError) {
    return error.failure;
  }
  return {
    status: 500,
    code: "join_failed",
    message: error instanceof Error ? error.message : "Join failed",
  };
}

/**
 * One slot's view of the shared generation: a single-producer /
 * single-consumer queue drained by one HTTP response.
 */
class SlotChannel {
  private readonly queued: ArenaEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<ArenaEvent>) => void> =
    [];
  private closed = false;
  private failure: Error | null = null;

  constructor(private readonly maxQueued: number) {}

  push(event: ArenaEvent): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: event });
      return;
    }
    if (this.queued.length >= this.maxQueued) {
      // Truncating the stream is bad; growing it without bound is worse, and a
      // reported failure is the only outcome the client can act on.
      this.fail(new Error("Slot stream fell too far behind its consumer"));
      return;
    }
    this.queued.push(event);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    if (this.closed || this.failure) {
      return;
    }
    this.failure = error;
    this.queued.length = 0;
    this.close();
  }

  /**
   * Drain this slot. Aborting `signal` ends only *this* connection; the shared
   * generation (and the other slot) is unaffected.
   */
  async *iterate(signal?: AbortSignal): AsyncGenerator<ArenaEvent> {
    const onAbort = (): void => this.close();
    if (signal?.aborted) {
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        const next = await this.next();
        if (next.done) {
          break;
        }
        yield next.value;
      }
      if (this.failure) {
        throw this.failure;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async next(): Promise<IteratorResult<ArenaEvent>> {
    const value = this.queued.shift();
    if (value !== undefined) {
      return { done: false, value };
    }
    if (this.closed) {
      return { done: true, value: undefined };
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * The one shared generation behind a joined matchup, demultiplexed into a
 * channel per slot.
 *
 * The leader owns it: it starts the pump, persists every event for both slots,
 * and keeps consuming even if its own client disappears, so slot B still
 * finishes and is recorded. Each connection is terminated by `matchup_done` as
 * soon as *its* slot is done, rather than waiting on the other one.
 */
export class JoinedRound {
  private readonly channels: Record<ArenaSlot, SlotChannel>;
  private readonly controller = new AbortController();
  private pumping = false;

  constructor(
    private readonly open: (signal: AbortSignal) => AsyncIterable<ArenaEvent>,
    private readonly onEvent: (event: ArenaEvent) => Promise<void>,
    maxQueued: number = DEFAULT_JOIN_MAX_QUEUED_EVENTS,
  ) {
    this.channels = {
      A: new SlotChannel(maxQueued),
      B: new SlotChannel(maxQueued),
    };
  }

  /**
   * Start the shared generation, cascading the leader's control-plane handle
   * onto it: stopping the matchup stops both slots. Idempotent.
   */
  start(signal?: AbortSignal): void {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    if (signal) {
      if (signal.aborted) {
        this.controller.abort();
      } else {
        signal.addEventListener("abort", () => this.controller.abort(), {
          once: true,
        });
      }
    }
    void this.pump();
  }

  slot(slot: ArenaSlot, signal?: AbortSignal): AsyncIterable<ArenaEvent> {
    return this.channels[slot].iterate(signal);
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.open(this.controller.signal)) {
        await this.onEvent(event);
        if (event.type === "matchup_done") {
          continue;
        }
        const channel = this.channels[event.slot];
        channel.push(event);
        if (event.type === "slot_done") {
          channel.push({ type: "matchup_done" });
          channel.close();
        }
      }
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error("Arena stream failed");
      this.channels.A.fail(error);
      this.channels.B.fail(error);
    } finally {
      this.channels.A.close();
      this.channels.B.close();
    }
  }
}

export type JoinClaim =
  /** First arrival: run the matchup, then serve slot A. */
  | { kind: "leader"; slot: "A"; session: JoinSession }
  /** Sibling: wait for the leader's matchup, then serve slot B. */
  | { kind: "follower"; slot: "B"; session: JoinSession }
  /** The window closed before this request arrived. */
  | { kind: "expired" }
  /** Both slots of this scope are already claimed. */
  | { kind: "exhausted" }
  /** Too many unpaired scopes in flight. */
  | { kind: "unavailable" };

export interface JoinSession {
  /**
   * Leader only: resolves `true` once the sibling claims slot B, `false` when
   * the window closes with no sibling.
   */
  sibling(): Promise<boolean>;
  /** Leader only: hand the shared matchup to the sibling. */
  publish(handshake: JoinHandshake, round: JoinedRound): void;
  /** Leader only: report a pre-stream failure to the sibling. */
  fail(failure: JoinFailure): void;
  /** Follower only: the leader's matchup, or the leader's failure. */
  accept(): Promise<{ handshake: JoinHandshake; round: JoinedRound }>;
}

interface PendingJoin extends JoinSession {
  claimed: Set<ArenaSlot>;
  state: "open" | "paired" | "expired";
  settledAt: number;
  /** Cancel the window and release the leader; called when the sibling lands. */
  pair(): void;
}

/**
 * Pairs sibling requests into one matchup.
 *
 * **Race-free by construction.** `claim` is entirely synchronous — no `await`
 * between deriving the scope key and recording the claim — so on Node's single
 * threaded loop two genuinely simultaneous siblings cannot both become leader,
 * whichever order they are dispatched in. Everything that can suspend (the
 * conversation read, the matchmaker, the insert) happens *after* the roles are
 * fixed, and the follower waits on a promise the leader resolves.
 *
 * **Memory-bounded.** At most `maxPending` scopes are tracked; each is a fixed
 * handful of strings plus two promises, is swept once its grace period passes,
 * and over the cap a join is refused rather than queued.
 */
export class JoinBroker {
  private readonly pending = new Map<string, PendingJoin>();
  private readonly secret: Buffer;
  private readonly graceMs: number;

  constructor(
    private readonly config: JoinConfig = joinConfigSchema.parse({}),
    /**
     * Ephemeral by default, and deliberately so: a scope key never leaves the
     * process and never has to survive a restart (the window is seconds), so a
     * per-process secret makes the key unguessable even to someone who knows
     * every configured secret the deployment has.
     */
    secret: Buffer | string = randomBytes(32),
  ) {
    this.secret = Buffer.isBuffer(secret) ? secret : Buffer.from(secret);
    // Settled scopes are remembered past the window so a late sibling is told
    // its join expired instead of silently opening a second matchup.
    this.graceMs = config.windowMs + 5_000;
  }

  /** Whether joining is available at all (`ARENA_JOIN_WINDOW_MS=0` disables it). */
  get enabled(): boolean {
    return this.config.windowMs > 0;
  }

  get maxQueuedEvents(): number {
    return this.config.maxQueuedEvents;
  }

  /** Exposed for tests; the value itself is not meaningful outside the broker. */
  scopeKey(scope: JoinScope): string {
    return createHmac("sha256", this.secret)
      .update(
        JSON.stringify([
          "arena-join-v1",
          scope.sessionId,
          scope.conversationId ?? "",
          scope.prompt,
          scope.joinKey,
        ]),
      )
      .digest("hex");
  }

  claim(scope: JoinScope, now = Date.now()): JoinClaim {
    this.sweep(now);
    const key = this.scopeKey(scope);
    const existing = this.pending.get(key);

    if (existing) {
      if (existing.state === "expired") {
        return { kind: "expired" };
      }
      if (existing.claimed.size >= 2) {
        return { kind: "exhausted" };
      }
      existing.claimed.add("B");
      existing.state = "paired";
      existing.settledAt = now;
      existing.pair();
      return { kind: "follower", slot: "B", session: existing };
    }

    if (this.pending.size >= this.config.maxPending) {
      return { kind: "unavailable" };
    }

    const entry = this.createPending(key, now);
    this.pending.set(key, entry);
    return { kind: "leader", slot: "A", session: entry };
  }

  /** Tracked scopes; for tests and for asserting the bound. */
  get pendingCount(): number {
    return this.pending.size;
  }

  private createPending(key: string, now: number): PendingJoin {
    let resolveSibling: (paired: boolean) => void = () => {};
    const siblingPromise = new Promise<boolean>((resolve) => {
      resolveSibling = resolve;
    });

    let resolveAccept: (
      value: { handshake: JoinHandshake; round: JoinedRound },
    ) => void = () => {};
    let rejectAccept: (error: unknown) => void = () => {};
    const acceptPromise = new Promise<{
      handshake: JoinHandshake;
      round: JoinedRound;
    }>((resolve, reject) => {
      resolveAccept = resolve;
      rejectAccept = reject;
    });
    // Nobody may be waiting on it, and an unhandled rejection would take the
    // process down.
    acceptPromise.catch(() => {});

    const timer = setTimeout(() => {
      const current = this.pending.get(key);
      if (current && current.state === "open") {
        current.state = "expired";
        current.settledAt = Date.now();
      }
      resolveSibling(false);
      // Unpaired: no sibling can ever be waiting on the leader now.
      clearTimeout(deadline);
    }, this.config.windowMs);
    // Never hold the process open waiting for a sibling.
    timer.unref?.();

    const deadline = setTimeout(() => {
      rejectAccept(
        new JoinFailureError({
          status: 504,
          code: "join_leader_timeout",
          message: "The request holding this matchup never started it",
        }),
      );
    }, this.config.windowMs + JOIN_PUBLISH_DEADLINE_MS);
    deadline.unref?.();

    const entry: PendingJoin = {
      claimed: new Set<ArenaSlot>(["A"]),
      state: "open",
      settledAt: 0,
      pair: () => {
        clearTimeout(timer);
        resolveSibling(true);
      },
      sibling: () => siblingPromise,
      publish: (handshake, round) => {
        clearTimeout(deadline);
        resolveAccept({ handshake, round });
      },
      fail: (failure) => {
        clearTimeout(deadline);
        rejectAccept(new JoinFailureError(failure));
      },
      accept: () => acceptPromise,
    };
    entry.settledAt = now;
    return entry;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.pending) {
      if (entry.state !== "open" && now - entry.settledAt >= this.graceMs) {
        this.pending.delete(key);
      }
    }
  }
}
