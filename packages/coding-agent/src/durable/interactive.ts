import { openDurable, type OpenDurableOptions } from "./runtime.ts";
import { runDurableTui } from "./tui.ts";
import { printTimings, time } from "../core/timings.ts";
import { installShutdownSignals, setShutdownTerminalRestore } from "../utils/shutdown-signals.ts";
import type { ImageContent } from "@amazme/ai";
import { recordCrash } from "../core/crash-log.ts";
import { join } from "node:path";

/** The default interactive session: one durable sqlite conversation, the same path the web host drives. */
export async function runDurableInteractive(
	options: OpenDurableOptions & {
		readonly initialMessage?: string;
		readonly initialImages?: readonly ImageContent[];
		readonly initialMessages?: readonly string[];
		readonly startupBenchmark?: boolean;
	},
): Promise<void> {
	const durable = await openDurable(options);
	let crashRecorded = false;
	const crash = (error: unknown, kind: "fatal_error" | "uncaught_exception"): void => {
		if (crashRecorded) return;
		crashRecorded = true;
		const session = durable.view.current().session;
		recordCrash({ kind, error, cwd: session.cwd, sessionFile: session.directory === undefined ? undefined : join(session.directory, "session.sqlite") });
	};
	const monitor = (error: Error): void => crash(error, "uncaught_exception");
	process.on("uncaughtExceptionMonitor", monitor);
	// Closing the terminal window hangs the terminal up. The kernel sends SIGHUP, which runs the same
	// graceful close as SIGTERM, and every later read or write on the terminal fails with EIO (EPIPE
	// once the other end of a pipe is gone). Stopping the screen still writes, so without a listener
	// that failure became an uncaught exception, a crash record and exit 1 for a window that was simply
	// closed. Only those codes are the terminal going away; anything else stays an uncaught error.
	const terminalStreams = [process.stdin, process.stdout, process.stderr] as const;
	const terminalGone = (error: NodeJS.ErrnoException): void => {
		if (error.code === "EIO" || error.code === "EPIPE") return;
		throw error;
	};
	for (const stream of terminalStreams) stream.on("error", terminalGone);
	time("openDurable");
	const inputs: Promise<boolean>[] = [];
	let exitTui = (): void => {};
	let restoreInput = (): void => {};
	let forced = false;
	// Listeners stay up for the whole shutdown. `process.once` drops them on the
	// first signal, and signal-exit (loaded by the session lock) then re-sends
	// SIGTERM and kills the process before `close` releases the lock.
	// The first SIGINT/SIGTERM/SIGHUP stops the screen, closes, then exits 0.
	// A later SIGINT while that close is still running force-exits. A repeat SIGTERM/SIGHUP does not.
	const shutdown = installShutdownSignals(() => {
		forced = true;
		exitTui();
	});
	let returned = false;
	try {
		if (!options.startupBenchmark) {
			if (options.initialMessage || options.initialImages?.length) {
				inputs.push(durable.controller.submit(options.initialMessage ?? "", "steer", options.initialImages));
			}
			for (const message of options.initialMessages ?? []) inputs.push(durable.controller.submit(message, "followUp"));
		}
		// Reserve initial inputs in the existing command queue; the live TUI can cancel preparation immediately.
		await runDurableTui(durable.view, durable.controller, durable.settings, durable.resources, durable.closed, options.startupBenchmark, {
			bindExit(exit) {
				exitTui = exit;
				if (forced) exit();
			},
			// `/quit` is the same graceful finish as the first signal: stop, close, exit 0.
			// It does not count as a SIGINT, so the first Ctrl-C during that close still waits.
			quit() {
				if (forced) return;
				forced = true;
				exitTui();
			},
			// Raw-mode Ctrl-C is a key (`app.clear`), not SIGINT. The first press is the
			// same graceful finish as the first signal: stop, close, exit 0, with the
			// listeners kept until `process.exit`. Once the screen is restored the terminal
			// is back in cooked mode, so a second Ctrl-C arrives as SIGINT; dropping the
			// listeners before exit would let that signal kill the process.
			// A second press, or that SIGINT while `close` is still running, force-exits.
			clear() {
				shutdown.key(() => {
					forced = true;
					exitTui();
				});
			},
			bindInputRestore(restore) {
				restoreInput = restore;
			},
			// The screen has stopped but stdin is still raw. A second Ctrl-C is a key, not a
			// SIGINT the kernel echoes as `^C`; during cleanup it force-exits.
			shutdownInput(data) {
				if (!data.includes("\x03")) return;
				shutdown.key(() => {
					forced = true;
					exitTui();
				});
			},
		});
		returned = true;
	} catch (error) {
		crash(error, "fatal_error");
		throw error;
	} finally {
		try {
			// The TUI releases its shutdown restore when it stops. Keep cooked input reachable
			// through the rest of cleanup, including a second Ctrl-C while close is held.
			setShutdownTerminalRestore(restoreInput);
			await durable.close();
			await Promise.all(inputs);
		} catch (error) {
			crash(error, "fatal_error");
			forced = false;
			throw error;
		} finally {
			process.off("uncaughtExceptionMonitor", monitor);
			// The exit transaction: the session is closed, so hand cooked input back and leave at once.
			restoreInput();
			setShutdownTerminalRestore(undefined);
			// A failed presentation must not exit 0, and must not leave the signal listeners behind.
			shutdown.finish();
			if (!forced || !returned) {
				for (const stream of terminalStreams) stream.off("error", terminalGone);
				shutdown.dispose();
				forced = false;
			}
		}
	}
	if (forced) {
		printTimings();
		process.exit(process.exitCode ?? 0);
	}
}
