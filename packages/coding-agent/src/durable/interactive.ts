import { openDurable, type OpenDurableOptions } from "./runtime.ts";
import { runDurableTui } from "./tui.ts";
import { printTimings, time } from "../core/timings.ts";
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
	// Keep the listeners installed. `process.once` removes them on the first
	// signal, and signal-exit (loaded by the session lock) then re-sends SIGTERM
	// and kills the process before `close` releases the lock. `/quit` uses this
	// same finish as SIGINT/SIGTERM: stop the screen, close, then exit.
	const forceExit = (): void => {
		if (forced) return;
		forced = true;
		exitTui();
	};
	process.on("SIGINT", forceExit);
	process.on("SIGTERM", forceExit);
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
			quit: forceExit,
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
			if (!forced || !returned) {
				process.off("SIGINT", forceExit);
				process.off("SIGTERM", forceExit);
				forced = false;
			}
		}
	}
	if (forced) {
		printTimings();
		process.exit(process.exitCode ?? 0);
	}
}
