/**
 * A tiny single-producer / single-consumer async queue. Omni-Arena interleaves
 * both slots on one connection, so the bridge demultiplexes that stream into
 * one channel per slot and lets each HTTP response drain its own.
 */
export class Channel {
  #queue = [];
  #waiters = [];
  #closed = false;

  push(value) {
    if (this.#closed) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.#queue.push(value);
    }
  }

  close() {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    let waiter;
    while ((waiter = this.#waiters.shift())) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#queue.length > 0) {
          return Promise.resolve({ value: this.#queue.shift(), done: false });
        }
        if (this.#closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
