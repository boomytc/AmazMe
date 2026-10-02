/**
 * Single-consumer queue. A second iterator throws.
 * `push` stores a structured clone, so later edits to the caller's object
 * do not change a snapshot that was already queued. Events after the terminal are dropped.
 */
export class EventStream<T, R> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private finished = false;
  private consumed = false;
  private readonly donePromise: Promise<R>;
  private resolveDone!: (result: R) => void;
  private settled = false;
  private readonly isComplete: (event: T) => boolean;
  private readonly extract: (event: T) => R;

  constructor(isComplete: (event: T) => boolean, extract: (event: T) => R) {
    this.isComplete = isComplete;
    this.extract = extract;
    this.donePromise = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  push(event: T): void {
    if (this.finished) return;
    const snapshot = structuredClone(event);
    if (this.isComplete(snapshot) && !this.settled) {
      this.settled = true;
      this.resolveDone(this.extract(snapshot));
      this.finished = true;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: snapshot, done: false });
    else this.queue.push(snapshot);
  }

  end(result: R): void {
    if (!this.settled) {
      this.settled = true;
      this.resolveDone(result);
    }
    this.finished = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as T, done: true });
    }
  }

  result(): Promise<R> {
    return this.donePromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) throw new Error("Assistant event stream has one consumer");
    this.consumed = true;
    return this.iterate();
  }

  private async *iterate(): AsyncGenerator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift() as T;
        continue;
      }
      if (this.finished) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
