import type { ArenaEvent, ArenaSlot } from "./events.js";
import type {
  MatchupAssignment,
  Model,
  ProviderResolverPort,
} from "./ports.js";

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
    prompt: string,
    assignment: MatchupAssignment,
  ): AsyncGenerator<ArenaEvent> {
    const queue = new AsyncEventQueue<ArenaEvent>();
    let activeSlots = 2;

    const produce = async (slot: ArenaSlot, model: Model): Promise<void> => {
      const startedAt = performance.now();
      let content = "";
      let error: string | null = null;

      try {
        const provider = this.providers.resolve(model.provider);
        for await (const token of provider.stream(model, prompt)) {
          content += token;
          queue.push({ type: "token", slot, token });
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : "Model stream failed";
        queue.push({ type: "slot_error", slot, message: error });
      } finally {
        queue.push({
          type: "slot_done",
          slot,
          content,
          latencyMs: Math.round(performance.now() - startedAt),
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
    void produce("B", assignment.slotB);

    while (true) {
      const next = await queue.next();
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }
}
