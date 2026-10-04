/**
 * Sends frames one at a time in enqueue order, awaiting each `send` before the next. Bytes still waiting are
 * bounded; going over the bound fails the stream instead of dropping a frame.
 */
export class FrameWriter {
  private readonly send: (chunk: Uint8Array) => Promise<void>;
  private readonly maxQueuedBytes: number;
  private readonly onFailure: (error: Error) => void;
  private readonly queue: Array<{ frame: Uint8Array; resolve: () => void; reject: (error: Error) => void }> = [];
  private queued = 0;
  private pumping = false;
  private failure: Error | undefined;

  constructor(send: (chunk: Uint8Array) => Promise<void>, maxQueuedBytes: number, onFailure: (error: Error) => void) {
    if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes <= 0) throw new RangeError("maxQueuedBytes must be a positive integer");
    this.send = send;
    this.maxQueuedBytes = maxQueuedBytes;
    this.onFailure = onFailure;
  }

  get queuedBytes(): number {
    return this.queued;
  }

  /** Resolves once the transport accepted the frame. Rejects when the writer has failed or overflows. */
  write(frame: Uint8Array, overflow: () => Error): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.queued + frame.byteLength > this.maxQueuedBytes) {
      const error = overflow();
      this.fail(error);
      return Promise.reject(error);
    }
    this.queued += frame.byteLength;
    const done = new Promise<void>((resolve, reject) => this.queue.push({ frame, resolve, reject }));
    void this.pump();
    return done;
  }

  /** Rejects every waiting frame; later writes reject with the same error. */
  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const item of this.queue.splice(0)) item.reject(error);
    this.queued = 0;
    this.onFailure(error);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.failure && this.queue.length > 0) {
        const item = this.queue[0]!;
        try {
          await this.send(item.frame);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (this.failure) return;
        this.queue.shift();
        this.queued -= item.frame.byteLength;
        item.resolve();
      }
    } finally {
      this.pumping = false;
    }
  }
}
