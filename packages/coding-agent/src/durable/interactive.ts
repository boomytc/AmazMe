import { openDurable, type OpenDurableOptions } from "./runtime.ts";
import { runDurableTui } from "./tui.ts";
import { printTimings, time } from "../core/timings.ts";
import { installShutdownSignals } from "../utils/shutdown-signals.ts";
import type { ImageContent } from "@amazme/ai";

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
	time("openDurable");
	const inputs: Promise<boolean>[] = [];
	let exitTui = (): void => {};
	let forced = false;
	// Listeners stay up for the whole shutdown. `process.once` drops them on the
	// first signal, and signal-exit (loaded by the session lock) then re-sends
	// SIGTERM and kills the process before `close` releases the lock.
	// The first SIGINT/SIGTERM stops the screen, closes, then exits 0.
	// A later SIGINT while that close is still running force-exits. A repeat SIGTERM does not.
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
			// Raw-mode Ctrl-C is a key (`app.clear`), not SIGINT. The first press
			// stops the screen without `process.exit`. A second press, or a SIGINT
			// once raw mode is off and `close` is still running, force-exits.
			clear() {
				shutdown.key(() => exitTui());
			},
		});
		returned = true;
	} finally {
		try {
			await durable.close();
			await Promise.all(inputs);
		} catch (error) {
			forced = false;
			throw error;
		} finally {
			// A failed presentation must not exit 0, and must not leave the signal listeners behind.
			shutdown.finish();
			if (!forced || !returned) {
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
