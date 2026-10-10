import { openDurable, type OpenDurableOptions } from "./runtime.ts";
import { runDurableTui } from "./tui.ts";
import { time } from "../core/timings.ts";
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
	try {
		if (!options.startupBenchmark) {
			if (options.initialMessage || options.initialImages?.length) {
				inputs.push(durable.controller.submit(options.initialMessage ?? "", "steer", options.initialImages));
			}
			for (const message of options.initialMessages ?? []) inputs.push(durable.controller.submit(message, "followUp"));
		}
		// Reserve initial inputs in the existing command queue; the live TUI can cancel preparation immediately.
		await runDurableTui(durable.view, durable.controller, durable.settings, durable.resources, durable.closed, options.startupBenchmark);
	} finally {
		await durable.close();
		await Promise.all(inputs);
	}
}
