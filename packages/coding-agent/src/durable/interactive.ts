import { openDurable, type OpenDurableOptions } from "./runtime.ts";
import { runDurableTui } from "./tui.ts";

/** The default interactive session: one durable sqlite conversation, the same path the web host drives. */
export async function runDurableInteractive(
	options: OpenDurableOptions & {
		readonly initialMessage?: string;
	},
): Promise<void> {
	const durable = await openDurable(options);
	try {
		if (options.initialMessage !== undefined && options.initialMessage.length > 0) {
			await durable.controller.submit(options.initialMessage, "steer");
		}
		await runDurableTui(durable.view, durable.controller, durable.settings);
	} finally {
		await durable.close();
	}
}
