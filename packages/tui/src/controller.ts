import type { AgentHook, AgentEvent, BeforeToolCallDecision, BeforeToolCallInput } from "@amazme/agent";
import type { Key } from "./keys.ts";
import { Transcript } from "./transcript.ts";
import type { ConfirmationPrompt, ScreenState } from "./frame.ts";

export interface FullscreenSession {
  prompt(input: string, signal?: AbortSignal): Promise<unknown>;
  agent: {
    subscribe(listener: (event: AgentEvent, signal?: AbortSignal) => Promise<void> | void): () => void;
    hooks: AgentHook[];
  };
}

interface QueuedLine {
  text: string;
  resolve: () => void;
}

/**
 * One session, one prompt at a time. Typed lines submitted while a turn is
 * open, or while that prompt call is still inside the agent, wait. They become
 * the next `session.prompt` only after the in-flight call settles, which is
 * after its `turn_end`. A second call before that throws inside the agent.
 * Empty Ctrl+C aborts the open turn only when `prompt` already accepts an
 * AbortSignal. This prompt does not, so the screen says the turn is still running.
 */
export class FullscreenController {
  readonly transcript = new Transcript();
  input = "";
  notice: string | null = null;
  failure: string | null = null;
  confirmation: ConfirmationPrompt | null = null;
  wantsExit = false;

  private readonly queued: QueuedLine[] = [];
  private readonly confirmQueue: Array<{ input: BeforeToolCallInput; resolve: (allowed: boolean) => void }> = [];
  private inflight = false;
  private turnAbort: AbortController | null = null;

  constructor(
    private readonly session: FullscreenSession,
    private readonly onChange?: () => void,
  ) {
    session.agent.subscribe((event) => {
      this.transcript.apply(event);
      if (event.type === "turn_end") this.notice = null;
      this.notify();
    });
    session.agent.hooks.push({ beforeToolCall: (input) => this.gateTool(input) });
  }

  get busy(): boolean {
    return this.transcript.busy;
  }

  get queuedCount(): number {
    return this.queued.length;
  }

  submit(line: string): Promise<void> {
    const text = line.trim();
    if (!text) return Promise.resolve();
    // y/n answers the question. A submitted line during that question, or any
    // other open turn, waits until this prompt call returns.
    if (this.confirmation || this.inflight || this.transcript.busy) {
      return new Promise((resolve) => {
        this.queued.push({ text, resolve });
        this.notify();
      });
    }
    return this.pump(text);
  }

  handleInput(key: Key): void {
    if (this.confirmation) {
      this.handleConfirmation(key);
      return;
    }
    if (key.type === "char") {
      this.input += key.value;
      this.notify();
      return;
    }
    if (key.type === "backspace") {
      const chars = Array.from(this.input);
      chars.pop();
      this.input = chars.join("");
      this.notify();
      return;
    }
    if (key.type === "enter") {
      const line = this.input;
      this.input = "";
      this.notify();
      void this.submit(line).catch(() => undefined);
      return;
    }
    if (key.type === "ctrl-c") {
      this.onInterrupt();
      return;
    }
    if (key.type === "ctrl-d" && this.input.length === 0 && !this.inflight && !this.transcript.busy) {
      this.wantsExit = true;
      this.notify();
    }
  }

  answer(allowed: boolean): void {
    const head = this.confirmQueue.shift();
    if (!head) return;
    head.resolve(allowed);
    this.showConfirmation();
  }

  snapshot(): ScreenState {
    return {
      lines: this.transcript.lines(),
      busy: this.transcript.busy,
      notice: this.notice,
      failure: this.failure,
      queued: this.queued.length,
      input: this.input,
      confirmation: this.confirmation,
    };
  }

  private handleConfirmation(key: Key): void {
    if (key.type === "char" && (key.value === "y" || key.value === "Y")) {
      this.answer(true);
      return;
    }
    if (key.type === "char" && (key.value === "n" || key.value === "N")) {
      this.answer(false);
      return;
    }
    if (key.type === "ctrl-c" && this.input.length === 0) this.onInterrupt();
  }

  private onInterrupt(): void {
    if (this.input.length > 0 && !this.confirmation) {
      this.input = "";
      this.notify();
      return;
    }
    if (!(this.transcript.busy || this.inflight)) {
      this.wantsExit = true;
      this.notify();
      return;
    }
    if (this.turnAbort && !this.turnAbort.signal.aborted) {
      this.turnAbort.abort();
      this.notify();
      return;
    }
    this.notice = "这一轮还在跑";
    this.notify();
  }

  private gateTool(input: BeforeToolCallInput): Promise<BeforeToolCallDecision | undefined> {
    return new Promise((resolve) => {
      this.confirmQueue.push({
        input,
        resolve: (allowed) => {
          resolve(allowed ? undefined : { action: "block", reason: "用户拒绝" });
        },
      });
      this.showConfirmation();
    });
  }

  private showConfirmation(): void {
    const head = this.confirmQueue[0];
    this.confirmation = head ? { toolName: head.input.toolName, args: head.input.args } : null;
    this.notify();
  }

  private async pump(text: string): Promise<void> {
    this.inflight = true;
    this.failure = null;
    this.notify();
    try {
      await this.invoke(text);
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.turnAbort = null;
      this.inflight = false;
      const next = this.queued.shift();
      if (next) void this.pump(next.text).then(next.resolve, () => next.resolve());
      this.notify();
    }
  }

  private invoke(text: string): Promise<unknown> {
    if (this.session.prompt.length >= 2) {
      this.turnAbort = new AbortController();
      return this.session.prompt(text, this.turnAbort.signal);
    }
    this.turnAbort = null;
    return this.session.prompt(text);
  }

  private notify(): void {
    try {
      this.onChange?.();
    } catch {
      // Drawing stays outside the agent loop. A listener throw would abort the turn.
    }
  }
}
