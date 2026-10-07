import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { WebHostLaunch } from "./launch.ts";
import { createReadinessParser } from "./readiness.ts";

const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Stdout and stderr retained for a failure dialog, including output after the launch line.
 * Older bytes are dropped. The dialog then shows the last few lines of this buffer.
 */
export const MAX_HOST_OUTPUT_CHARS = 32_768;

/** Why `start` rejected. `message` is the sentence the rejection Error carries, without the tail. */
export type HostStartupFailure =
	| {
			readonly kind: "spawn-error" | "readiness-timeout" | "invalid-output";
			readonly message: string;
			readonly tail: string;
	  }
	| {
			readonly kind: "exit-before-ready";
			readonly message: string;
			readonly code: number | null;
			readonly signal: NodeJS.Signals | null;
			readonly tail: string;
	  };

/** A host that was ready and then left while the shell was not shutting it down. */
export interface HostExitDetail {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly tail: string;
}

/** Child the supervisor owns. Tests substitute a fake; the app uses a Node process. */
export interface HostChild {
	readonly stdout: { onData(listener: (chunk: string) => void): () => void };
	readonly stderr: { onData(listener: (chunk: string) => void): () => void };
	onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
	onError(listener: (error: Error) => void): () => void;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface HostSupervisorOptions {
	readonly spawnHost: () => HostChild;
	readonly readinessTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly log?: (chunk: string) => void;
	/** Structured cause when `start` rejects: spawn error, exit before ready, timeout, or bad output. */
	readonly onStartupFailure?: (failure: HostStartupFailure) => void;
	/** The child was ready, then exited while shutdown had not started. */
	readonly onUnexpectedExit?: (detail: HostExitDetail) => void;
}

export interface HostSupervisor {
	/** Start once. Later calls join the same attempt. */
	start(): Promise<string>;
	/** Stop once. SIGTERM, then SIGKILL after the grace period. */
	shutdown(): Promise<void>;
	/** Bounded tail of stdout and stderr. Still grows after the launch line, then drops the head. */
	tail(): string;
}

interface NodeChildOptions {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}

/** Spawn a Node process whose stdout and stderr the supervisor reads to completion. */
export function spawnNodeChild(options: NodeChildOptions): HostChild {
	const child = spawn(options.executable, [...options.args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	return nodeChildAdapter(child);
}

/** The experimental `web` command. The page it prints is the one the window loads. */
export function spawnWebHost(launch: WebHostLaunch): HostChild {
	return spawnNodeChild({
		executable: launch.nodeExecutable,
		args: launch.args,
		cwd: launch.cwd,
		env: launch.env,
	});
}

function streamAdapter(stream: Readable): HostChild["stdout"] {
	return {
		onData(listener) {
			const accept = (chunk: string | Buffer): void => {
				listener(chunk.toString());
			};
			stream.on("data", accept);
			return () => {
				stream.off("data", accept);
			};
		},
	};
}

function terminate(child: ChildProcessByStdio<null, Readable, Readable>, signal: "SIGTERM" | "SIGKILL"): void {
	if (child.pid === undefined) return;
	// A Windows host pulls in detached session workers. Killing the tree is what stops them.
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		return;
	}
	child.kill(signal);
}

function nodeChildAdapter(child: ChildProcessByStdio<null, Readable, Readable>): HostChild {
	return {
		stdout: streamAdapter(child.stdout),
		stderr: streamAdapter(child.stderr),
		onExit(listener) {
			child.on("exit", listener);
			return () => {
				child.off("exit", listener);
			};
		},
		onError(listener) {
			child.on("error", listener);
			return () => {
				child.off("error", listener);
			};
		},
		kill(signal) {
			terminate(child, signal);
		},
	};
}

/**
 * Own one web-host process: resolve when its launch line arrives, and keep reading output so the
 * pipe cannot stall the host after that.
 */
export function createHostSupervisor(options: HostSupervisorOptions): HostSupervisor {
	const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
	let child: HostChild | undefined;
	let startPromise: Promise<string> | undefined;
	let shutdownPromise: Promise<void> | undefined;
	let exited: Promise<void> | undefined;
	let exitResolve: (() => void) | undefined;
	let ready = false;
	let shuttingDown = false;
	let output = "";
	let readinessTimer: ReturnType<typeof setTimeout> | undefined;

	const note = (chunk: string): void => {
		output = `${output}${chunk}`.slice(-MAX_HOST_OUTPUT_CHARS);
		options.log?.(chunk);
	};

	const start = (): Promise<string> => {
		if (startPromise !== undefined) return startPromise;
		if (shutdownPromise !== undefined) {
			return Promise.reject(new Error("desktop host cannot start after shutdown"));
		}
		startPromise = new Promise<string>((resolve, reject) => {
			const parser = createReadinessParser();
			const spawned = options.spawnHost();
			child = spawned;
			exited = new Promise<void>((accept) => {
				exitResolve = accept;
			});
			let settled = false;

			const stopTimer = (): void => {
				if (readinessTimer === undefined) return;
				clearTimeout(readinessTimer);
				readinessTimer = undefined;
			};
			const fail = (failure: HostStartupFailure): void => {
				if (settled) return;
				settled = true;
				stopTimer();
				options.onStartupFailure?.(failure);
				const diagnostic = failure.tail === "" ? "" : `\n${failure.tail}`;
				reject(new Error(`${failure.message}${diagnostic}`));
			};

			readinessTimer = setTimeout(() => {
				fail({
					kind: "readiness-timeout",
					message: `desktop host readiness timed out after ${String(readinessTimeoutMs)}ms`,
					tail: output,
				});
				spawned.kill("SIGTERM");
			}, readinessTimeoutMs);

			spawned.stdout.onData((chunk) => {
				note(chunk);
				if (settled) return;
				try {
					const url = parser.push(chunk);
					if (url === undefined) return;
					settled = true;
					ready = true;
					stopTimer();
					resolve(url);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					fail({ kind: "invalid-output", message, tail: output });
					spawned.kill("SIGTERM");
				}
			});
			spawned.stderr.onData(note);
			spawned.onError((error) => {
				fail({
					kind: "spawn-error",
					message: `desktop host failed to spawn: ${error.message}`,
					tail: output,
				});
				exitResolve?.();
			});
			spawned.onExit((code, signal) => {
				exitResolve?.();
				if (ready) {
					if (!shuttingDown) options.onUnexpectedExit?.({ code, signal, tail: output });
					return;
				}
				try {
					const url = parser.finalize();
					if (settled) return;
					settled = true;
					ready = true;
					stopTimer();
					resolve(url);
				} catch {
					fail({
						kind: "exit-before-ready",
						message: `desktop host exited before readiness (code ${String(code)}, signal ${String(signal)})`,
						code,
						signal,
						tail: output,
					});
				}
			});
		});
		return startPromise;
	};

	const shutdown = (): Promise<void> => {
		shutdownPromise ??= (async () => {
			const spawned = child;
			if (spawned === undefined) return;
			shuttingDown = true;
			if (readinessTimer !== undefined) {
				clearTimeout(readinessTimer);
				readinessTimer = undefined;
			}
			spawned.kill("SIGTERM");
			const closed = exited ?? Promise.resolve();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const outcome = await Promise.race([
				closed.then(() => "closed" as const),
				new Promise<"timeout">((accept) => {
					timer = setTimeout(() => {
						accept("timeout");
					}, shutdownTimeoutMs);
				}),
			]);
			if (timer !== undefined) clearTimeout(timer);
			if (outcome === "timeout") {
				spawned.kill("SIGKILL");
				await closed;
			}
		})();
		return shutdownPromise;
	};

	return { start, shutdown, tail: () => output };
}
