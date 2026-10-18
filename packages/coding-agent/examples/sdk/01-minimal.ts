/**
 * Minimal SDK usage.
 *
 * Discovers skills, tools, and context files from cwd and ~/.amazme/agent.
 * The model comes from settings or the first available model.
 */

import { createDurableSession } from "@amazme/coding-agent";

const session = await createDurableSession();

try {
	session.subscribe((events) => {
		for (const event of events) {
			if (event.type !== "message_update") continue;
			for (const change of event.changes) {
				if (change.type === "text_delta") process.stdout.write(change.delta);
			}
		}
	});

	await session.prompt("What files are in the current directory?");
	for (const message of session.messages()) console.log(message);
	console.log();
} finally {
	await session.dispose();
}
