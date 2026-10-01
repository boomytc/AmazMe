export class EventStream<T, R> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private finished = false;
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
    if (this.isComplete(event) && !this.settled) {
      this.settled = true;
      this.resolveDone(this.extract(event));
      this.finished = true;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
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

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
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
