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
 * Persistent SIGINT and SIGTERM listeners.
 *
 * The first of either calls `onFirst` once. A later SIGINT, while cleanup has not finished,
 * force-exits. Later SIGTERMs stay ignored: `signal-exit` (loaded by proper-lockfile) re-sends
 * SIGTERM during shutdown, and dropping the listener lets that signal kill the process before
 * sockets and the session lock are released.
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

	const onSigterm = (): void => {
		// A repeat SIGTERM must not force-exit and must not take the default action.
		if (finished || cleaning) return;
		begin();
	};

	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

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
			process.off("SIGTERM", onSigterm);
		},
	};
}

/**
 * Wait until `closed` settles or the first SIGINT/SIGTERM arrives, then run `close`.
 * A SIGINT while `close` is still running force-exits. Listeners stay installed afterward.
 */
export async function closeAfterSignal(
	closed: Promise<void>,
	close: () => Promise<void>,
	arm?: (finish: () => void) => void,
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
	arm?.(finish);
	void closed.then(finish, fail);
	try {
		await done;
	} finally {
		try {
			await close();
		} finally {
			shutdown.finish();
		}
	}
}
