import type { ArenaEvent, ArenaSlot } from "./events.js";
import type { ChatMessage, Model, ProviderResolverPort } from "./ports.js";
import { calculateMarkdownDensity, estimateTokenCount } from "./style.js";

class AsyncEventQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return { done: false, value };
    }
    if (this.closed) {
      return { done: true, value: undefined };
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** Mid-stream steer handle: returns false when the matchup cannot accept it. */
export type SteerFn = (instruction: string) => boolean;

/**
 * Append an operator instruction as a system turn so both slots see the same
 * prompt (blindness). Providers that lack a system role (e.g. Google) map it to
 * user; OpenAI-compatible endpoints receive it as `system`.
 */
export function withSteerInstruction(
  messages: ChatMessage[],
  instruction: string,
): ChatMessage[] {
  return [...messages, { role: "system", content: instruction }];
}

export class ArenaCore {
  constructor(private readonly providers: ProviderResolverPort) {}

  /**
   * Multiplex one model per slot into a single event stream. Omitting `B` is
   * how a single (non-comparison) round is expressed — the alternative, a
   * two-slot assignment with the same model twice plus a slot count, made the
   * unused slot look meaningful in logs and types.
   *
   * `signal` is the control-plane **stop** handle: aborting closes the stream.
   * `attachSteer` registers abort-and-restart steering: the current generation
   * is cancelled (without closing the outer stream), a `steered` event is
   * emitted, and both slots re-run with the instruction appended identically.
   */
  async *stream(
    messages: ChatMessage[],
    slots: { A: Model; B?: Model },
    signal?: AbortSignal,
    attachSteer?: (steer: SteerFn) => void,
  ): AsyncGenerator<ArenaEvent> {
    const queue = new AsyncEventQueue<ArenaEvent>();
    let stopped = false;
    // Ref object so nested assignments stay visible to the outer finally (CFA
    // does not track reassignments inside the generation Promise executor).
    const generation = { controller: null as AbortController | null };
    /** True while the active generation is being torn down for a steer. */
    let steering = false;
    let pendingInstruction: string | null = null;
    /** Slots that completed the current generation (blocks further steers). */
    let completedInGeneration = 0;
    const appliedSteers: string[] = [];

    const acceptSteer: SteerFn = (instruction: string): boolean => {
      if (stopped || signal?.aborted) {
        return false;
      }
      // Once any slot has finished this generation, restart would desync
      // consumers that already saw `slot_done` (JoinedRound closes that channel).
      if (completedInGeneration > 0) {
        return false;
      }
      const controller = generation.controller;
      if (!controller || controller.signal.aborted) {
        return false;
      }
      pendingInstruction = instruction;
      steering = true;
      controller.abort();
      return true;
    };
    attachSteer?.(acceptSteer);

    const onStop = (): void => {
      stopped = true;
      generation.controller?.abort();
      queue.close();
    };
    if (signal) {
      if (signal.aborted) {
        return;
      }
      signal.addEventListener("abort", onStop, { once: true });
    }

    const runGeneration = (
      prompt: ChatMessage[],
    ): Promise<"steered" | "done" | "stopped"> =>
      new Promise((resolve) => {
        generation.controller = new AbortController();
        const genSignal = generation.controller.signal;
        let activeSlots = slots.B ? 2 : 1;
        let settled = false;
        completedInGeneration = 0;
        steering = false;

        const settle = (outcome: "steered" | "done" | "stopped"): void => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(outcome);
        };

        const produce = async (slot: ArenaSlot, model: Model): Promise<void> => {
          const startedAt = performance.now();
          let content = "";
          let error: string | null = null;
          let firstTokenAt: number | null = null;
          let modelVersion: string | null = null;
          let providerTokenCount: number | null = null;

          const whenAborted = (abortSignal: AbortSignal): Promise<"aborted"> =>
            new Promise((resolve) => {
              if (abortSignal.aborted) {
                resolve("aborted");
                return;
              }
              abortSignal.addEventListener(
                "abort",
                () => resolve("aborted"),
                { once: true },
              );
            });

          const iterator = this.providers
            .resolve(model.provider)
            .stream(model, prompt)[Symbol.asyncIterator]();

          try {
            while (!stopped && !signal?.aborted && !genSignal.aborted) {
              const raced = await Promise.race([
                iterator.next().then(
                  (result) => ({ kind: "next" as const, result }),
                ),
                whenAborted(genSignal).then(
                  () => ({ kind: "aborted" as const }),
                ),
                ...(signal
                  ? [
                      whenAborted(signal).then(
                        () => ({ kind: "aborted" as const }),
                      ),
                    ]
                  : []),
              ]);
              if (raced.kind === "aborted") {
                break;
              }
              if (raced.result.done) {
                break;
              }
              const chunk = raced.result.value;
              if (chunk.type === "metadata") {
                modelVersion = chunk.modelVersion ?? modelVersion;
                providerTokenCount =
                  chunk.outputTokenCount ?? providerTokenCount;
                continue;
              }

              if (firstTokenAt === null) {
                firstTokenAt = performance.now();
              }
              content += chunk.token;
              queue.push({ type: "token", slot, token: chunk.token });
            }
          } catch (caught) {
            if (!genSignal.aborted && !stopped && !signal?.aborted) {
              error =
                caught instanceof Error ? caught.message : "Model stream failed";
              queue.push({ type: "slot_error", slot, message: error });
            }
          } finally {
            // Do not await return(): providers blocked on I/O would hang the
            // steer/stop tear-down. Dropping the iterator is enough.
            void iterator.return?.().catch(() => undefined);
            activeSlots -= 1;

            // Steer tear-down: suppress terminal events so the outer stream
            // stays open for the restarted generation.
            if (steering || (genSignal.aborted && pendingInstruction)) {
              if (activeSlots === 0) {
                settle("steered");
              }
              return;
            }

            if (stopped || signal?.aborted) {
              if (activeSlots === 0) {
                settle("stopped");
              }
              return;
            }

            const finishedAt = performance.now();
            const streamDurationMs = Math.round(finishedAt - startedAt);
            const outputTokenCount =
              providerTokenCount ?? estimateTokenCount(content);
            completedInGeneration += 1;
            queue.push({
              type: "slot_done",
              slot,
              content,
              latencyMs: streamDurationMs,
              ttftMs:
                firstTokenAt === null
                  ? null
                  : Math.round(firstTokenAt - startedAt),
              streamDurationMs,
              outputTokenCount,
              tokenCountSource:
                providerTokenCount === null ? "estimated" : "provider",
              markdownDensity: calculateMarkdownDensity(content),
              modelVersion,
              error,
            });
            if (activeSlots === 0) {
              queue.push({ type: "matchup_done" });
              settle("done");
            }
          }
        };

        void produce("A", slots.A);
        if (slots.B) {
          void produce("B", slots.B);
        }
      });

    const driver = (async (): Promise<void> => {
      let prompt = messages;
      try {
        while (!stopped && !signal?.aborted) {
          pendingInstruction = null;
          const outcome = await runGeneration(prompt);
          if (outcome === "stopped") {
            return;
          }
          if (outcome === "done") {
            queue.close();
            return;
          }

          const instruction = pendingInstruction;
          pendingInstruction = null;
          steering = false;
          if (!instruction) {
            queue.close();
            return;
          }
          appliedSteers.push(instruction);
          queue.push({ type: "steered", instruction });
          // Cumulative: each restart sees every steer so far, identically on
          // both slots. Rebuild from the original messages so operator turns
          // stay contiguous at the end.
          prompt = [
            ...messages,
            ...appliedSteers.map(
              (steer): ChatMessage => ({ role: "system", content: steer }),
            ),
          ];
        }
      } finally {
        if (!stopped) {
          queue.close();
        }
      }
    })();

    try {
      while (true) {
        const next = await queue.next();
        if (next.done) {
          return;
        }
        yield next.value;
      }
    } finally {
      signal?.removeEventListener("abort", onStop);
      stopped = true;
      generation.controller?.abort();
      await driver.catch(() => undefined);
    }
  }
}
