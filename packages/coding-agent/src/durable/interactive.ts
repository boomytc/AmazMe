import { openDurable, type OpenDurableOptions } from "./runtime.ts";
import { runDurableTui } from "./tui.ts";
import { time } from "../core/timings.ts";

/** The default interactive session: one durable sqlite conversation, the same path the web host drives. */
export async function runDurableInteractive(
	options: OpenDurableOptions & {
		readonly initialMessage?: string;
		readonly startupBenchmark?: boolean;
	},
): Promise<void> {
	const durable = await openDurable(options);
	time("openDurable");
	try {
		if (!options.startupBenchmark && options.initialMessage !== undefined && options.initialMessage.length > 0) {
			await durable.controller.submit(options.initialMessage, "steer");
		}
		await runDurableTui(durable.view, durable.controller, durable.settings, durable.resources, durable.closed, options.startupBenchmark);
	} finally {
		await durable.close();
	}
}
