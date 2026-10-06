import { killProcessTree, untrackDetachedChildPid } from "../utils/shell.ts";

/** Foreground shell commands that can leave the conversation without being killed. */

export type ForegroundStatus = "running" | "completed" | "failed";

export interface ForegroundTask {
	id: string;
	command: string;
	status: ForegroundStatus;
	output: string;
	exitCode: number | null;
	pid: number | undefined;
	/** True after the command leaves the foreground and keeps running. */
	detached: boolean;
}

export interface ForegroundCompletion {
	command: string;
	output: string;
	exitCode: number | null;
}

interface RunningCommand extends ForegroundTask {
	detached: boolean;
	detachAbort: () => void;
	resolveDetach: () => void;
	detachedPromise: Promise<void>;
}

/**
 * Tracks the one foreground command and the tasks left behind when it is backgrounded.
 * Bash execution and the interactive composer share this registry.
 */
export class ForegroundCommands {
	private running: RunningCommand | undefined;
	private readonly tasks: ForegroundTask[] = [];
	private readonly listeners = new Set<() => void>();
	private readonly completionListeners = new Set<(completion: ForegroundCompletion) => void>();
	private nextId = 1;

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onComplete(listener: (completion: ForegroundCompletion) => void): () => void {
		this.completionListeners.add(listener);
		return () => this.completionListeners.delete(listener);
	}

	attach(input: { command: string; pid: number | undefined; detachAbort: () => void }): {
		noteOutput: (chunk: string) => void;
		finish: (exitCode: number | null) => void;
		isDetached: () => boolean;
		whenDetached: Promise<void>;
	} {
		let resolveDetach = () => {};
		const detachedPromise = new Promise<void>((resolve) => {
			resolveDetach = resolve;
		});
		const running: RunningCommand = {
			id: `cmd-${this.nextId++}`,
			command: input.command,
			status: "running",
			output: "",
			exitCode: null,
			pid: input.pid,
			detached: false,
			detachAbort: input.detachAbort,
			resolveDetach,
			detachedPromise,
		};
		this.running = running;
		this.tasks.push(running);
		this.emit();
		return {
			noteOutput: (chunk: string) => {
				running.output += chunk;
				this.emit();
			},
			finish: (exitCode: number | null) => {
				if (running.status !== "running") return;
				running.exitCode = exitCode;
				running.status = exitCode === 0 ? "completed" : "failed";
				if (this.running === running) this.running = undefined;
				if (running.detached) {
					const completion = { command: running.command, output: running.output, exitCode };
					for (const listener of this.completionListeners) listener(completion);
				} else {
					const index = this.tasks.indexOf(running);
					if (index >= 0) this.tasks.splice(index, 1);
				}
				this.emit();
			},
			isDetached: () => running.detached,
			whenDetached: detachedPromise,
		};
	}

	/** Leave the foreground command running and return control to the conversation. */
	backgroundCurrent(): boolean {
		const running = this.running;
		if (!running || running.detached || running.status !== "running") return false;
		running.detached = true;
		running.detachAbort();
		running.resolveDetach();
		this.emit();
		return true;
	}

	runningPid(): number | undefined {
		return this.running?.pid;
	}

	/** Stop one running command. A detached command still reports its exit afterward. */
	stop(id: string): boolean {
		const task = this.tasks.find((item) => item.id === id && item.status === "running");
		if (!task?.pid) return false;
		untrackDetachedChildPid(task.pid);
		killProcessTree(task.pid);
		return true;
	}

	list(): readonly ForegroundTask[] {
		return this.tasks;
	}

	reset(): void {
		this.running = undefined;
		this.tasks.length = 0;
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

export const foregroundCommands = new ForegroundCommands();
