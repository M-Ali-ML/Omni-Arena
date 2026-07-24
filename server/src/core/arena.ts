import type { ArenaEvent, ArenaSlot } from "./events.js";
import type {
  ChatMessage,
  MatchupAssignment,
  Model,
  ProviderResolverPort,
} from "./ports.js";
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

export class ArenaCore {
  constructor(private readonly providers: ProviderResolverPort) {}

  async *stream(
    messages: ChatMessage[],
    assignment: MatchupAssignment,
    signal?: AbortSignal,
    options: { activeSlots?: 1 | 2 } = {},
  ): AsyncGenerator<ArenaEvent> {
    const slotCount = options.activeSlots ?? 2;
    const queue = new AsyncEventQueue<ArenaEvent>();
    let activeSlots = slotCount;

    // Control-plane cancellation: aborting unblocks the consumer immediately so
    // the route stops emitting; in-flight producers observe `signal.aborted` and
    // break out of their provider stream on the next chunk.
    const onAbort = (): void => queue.close();
    if (signal) {
      if (signal.aborted) {
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const produce = async (slot: ArenaSlot, model: Model): Promise<void> => {
      const startedAt = performance.now();
      let content = "";
      let error: string | null = null;
      let firstTokenAt: number | null = null;
      let modelVersion: string | null = null;
      let providerTokenCount: number | null = null;

      try {
        const provider = this.providers.resolve(model.provider);
        for await (const chunk of provider.stream(model, messages)) {
          if (signal?.aborted) {
            break;
          }
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
        error = caught instanceof Error ? caught.message : "Model stream failed";
        queue.push({ type: "slot_error", slot, message: error });
      } finally {
        const finishedAt = performance.now();
        const streamDurationMs = Math.round(finishedAt - startedAt);
        const outputTokenCount =
          providerTokenCount ?? estimateTokenCount(content);
        queue.push({
          type: "slot_done",
          slot,
          content,
          latencyMs: streamDurationMs,
          ttftMs:
            firstTokenAt === null ? null : Math.round(firstTokenAt - startedAt),
          streamDurationMs,
          outputTokenCount,
          tokenCountSource:
            providerTokenCount === null ? "estimated" : "provider",
          markdownDensity: calculateMarkdownDensity(content),
          modelVersion,
          error,
        });
        activeSlots -= 1;
        if (activeSlots === 0) {
          queue.push({ type: "matchup_done" });
          queue.close();
        }
      }
    };

    void produce("A", assignment.slotA);
    if (slotCount === 2) {
      void produce("B", assignment.slotB);
    }

    try {
      while (true) {
        const next = await queue.next();
        if (next.done) {
          return;
        }
        yield next.value;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
