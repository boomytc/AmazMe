import * as fs from "node:fs";

/**
 * 128 + SIGINT. A second Ctrl-C while cleanup is still running leaves through this status.
 * The copy below matches the session lock's stale window (`SESSION_LOCK_STALE_MS` in
 * `durable/sessions.ts`): a holder that dies without releasing the lock can be taken over
 * after about 10 seconds.
 */
export const SHUTDOWN_FORCE_EXIT_CODE = 130;

/** One English line on stderr, written synchronously so a pipe still receives it. */
export const SHUTDOWN_FORCE_EXIT_MESSAGE =
	"Forced exit. The session lock expires in about 10 seconds; you can reopen the session then.";

/**
 * Synchronous screen restore invoked at the start of {@link forceShutdownExit}.
 * A second Ctrl-C in the same stdin chunk runs before the graceful stop microtask,
 * while the alternate screen and raw mode are still active.
 */
let restoreTerminal: (() => void) | undefined;

/** Bytes and the status of a force exit. Kept together so the restore can run first. */
export const shutdownExit = {
	writeStderr(text: string): void {
		fs.writeSync(process.stderr.fd, text);
	},
	exit(code: number): never {
		process.exit(code);
	},
};

/**
 * The stderr line of a force exit. On a terminal it starts with a carriage return and
 * erase-to-end-of-line: a second Ctrl-C after the TUI has already returned to cooked mode
 * is echoed by the terminal as `^C`, and the message must not be appended to that echo.
 * A pipe gets the plain message.
 */
export function forceShutdownExitLine(stderrIsTTY: boolean): string {
	return `${stderrIsTTY ? "\r\x1b[K" : ""}${SHUTDOWN_FORCE_EXIT_MESSAGE}\n`;
}

export function setShutdownTerminalRestore(restore: (() => void) | undefined): void {
	restoreTerminal = restore;
}

/** Stop immediately. Cleanup is abandoned; a later SIGINT must not wait on it. */
export function forceShutdownExit(): never {
	const restore = restoreTerminal;
	restoreTerminal = undefined;
	try {
		restore?.();
	} catch {
		// The process still has to leave, even if the screen could not be restored.
	}
	try {
		shutdownExit.writeStderr(forceShutdownExitLine(process.stderr.isTTY === true));
	} catch {
		// Stderr can be gone. The process still has to leave.
	}
	// A method call is not an unreachable end for control-flow analysis.
	const exit = shutdownExit.exit;
	exit(SHUTDOWN_FORCE_EXIT_CODE);
	throw new Error("force exit did not terminate");
}

export interface ShutdownSignals {
	/** True after the first shutdown request until {@link ShutdownSignals.finish}. */
	readonly cleaning: boolean;
	/**
	 * Raw-mode Ctrl-C. The first call marks cleanup and runs `onFirst`.
	 * A later call, while cleanup has not finished, force-exits.
	 * A later SIGINT does too: after the screen stops, raw mode is off and Ctrl-C is a signal.
	 */
	key(onFirst: () => void): void;
	/** Cleanup settled. Later signals are ignored, including a SIGINT, so the exit status stays 0. */
	finish(): void;
	/**
	 * Drop the listeners. A signal-driven shutdown leaves them installed until `process.exit`,
	 * so `signal-exit` can re-send SIGTERM without killing the process in that gap.
	 */
	dispose(): void;
}

/**
 * Signals that end the process like SIGTERM: a repeat is ignored, never a force exit.
 * SIGHUP is what the terminal sends when its window closes; it gets the same graceful close, so
 * a closed window leaves no stale socket or `--no-session` artifact directory behind.
 * Windows has no SIGHUP delivery from a closed console worth handling here.
 */
const TERMINATION_SIGNALS: readonly NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];

/**
 * Persistent SIGINT, SIGTERM and SIGHUP listeners.
 *
 * The first of any calls `onFirst` once. A later SIGINT, while cleanup has not finished,
 * force-exits. Later SIGTERMs and SIGHUPs stay ignored: `signal-exit` (loaded by proper-lockfile)
 * re-sends the signal it caught during shutdown, and dropping the listener lets that signal kill the
 * process before sockets and the session lock are released.
 *
 * Listeners stay until {@link ShutdownSignals.dispose}.
 */
export function installShutdownSignals(onFirst: () => void): ShutdownSignals {
	let cleaning = false;
	let finished = false;

	const begin = (): void => {
		if (finished || cleaning) return;
		cleaning = true;
		onFirst();
	};

	const onSigint = (): void => {
		if (finished) return;
		if (cleaning) {
			forceShutdownExit();
			return;
		}
		begin();
	};

	const onTermination = (): void => {
		// A repeat SIGTERM/SIGHUP must not force-exit and must not take the default action.
		if (finished || cleaning) return;
		begin();
	};

	process.on("SIGINT", onSigint);
	for (const signal of TERMINATION_SIGNALS) process.on(signal, onTermination);

	return {
		get cleaning() {
			return cleaning && !finished;
		},
		key(onFirst: () => void) {
			if (finished) return;
			if (cleaning) {
				forceShutdownExit();
				return;
			}
			cleaning = true;
			onFirst();
		},
		finish() {
			finished = true;
		},
		dispose() {
			process.off("SIGINT", onSigint);
			for (const signal of TERMINATION_SIGNALS) process.off(signal, onTermination);
		},
	};
}

/** A started resource that reports when it stops on its own and can be closed. */
export interface SignalClosable {
	readonly closed: Promise<void>;
	close(): Promise<void>;
}

/**
 * Start a resource and run it until `closed` settles or the first SIGINT/SIGTERM/SIGHUP arrives,
 * then run its `close`.
 *
 * This function owns the order: the signal listeners are installed first, and only then does
 * `start` bind and listen. There is no shape that takes an already-listening resource, so a caller
 * cannot open a socket in the window where a signal still takes the default action and leaves the
 * socket file behind. A signal that arrives while `start` is still running is remembered: once
 * `start` resolves, `arm` is skipped and `close` runs at once, so the socket is unlinked either way.
 * If `start` rejects, it has cleaned up after itself; the listeners are dropped and the error
 * propagates.
 *
 * `arm` is required and runs synchronously after `start` resolved, with the started resource, when
 * no signal has arrived yet: print readiness there (a `Socket:` line, launch lines). It is the only
 * point where the resource exists and the listeners are known to be up, so every caller decides
 * where its readiness goes; a caller that prints nothing passes a no-op. `finish` ends the wait
 * early, as a signal would.
 *
 * A SIGINT while `start` or `close` is still running force-exits. A repeat SIGTERM/SIGHUP does not:
 * `signal-exit` (loaded by proper-lockfile) re-sends it. Listeners stay installed after a signal-driven
 * close; callers exit immediately after this returns, because once the loop drains Node drops the
 * signal watchers and a SIGTERM in that gap would become the process's death signal.
 */
export async function closeWhenSignaled<T extends SignalClosable>(
	start: () => Promise<T>,
	arm: (running: T, finish: () => void) => void,
): Promise<void> {
	let settled = false;
	let resolveWait!: () => void;
	let rejectWait!: (error: unknown) => void;
	const done = new Promise<void>((resolve, reject) => {
		resolveWait = resolve;
		rejectWait = reject;
	});
	const finish = (): void => {
		if (settled) return;
		settled = true;
		resolveWait();
	};
	const fail = (error: unknown): void => {
		if (settled) return;
		settled = true;
		rejectWait(error);
	};
	const shutdown = installShutdownSignals(finish);
	let running: T;
	try {
		running = await start();
	} catch (error) {
		shutdown.finish();
		shutdown.dispose();
		// A signal during a failed start already settled `done`; nothing awaits it.
		done.catch(() => {});
		throw error;
	}
	void running.closed.then(finish, fail);
	try {
		// A throwing `arm` still closes what `start` opened.
		if (!settled) arm(running, finish);
		await done;
	} finally {
		try {
			await running.close();
		} finally {
			shutdown.finish();
		}
	}
}
