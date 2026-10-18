/**
 * Custom system prompt.
 *
 * `systemPrompt` replaces the discovered prompt file. `appendSystemPrompt` adds text after it.
 */

import { createDurableSession } from "@amazme/coding-agent";

const replaced = await createDurableSession({
	systemPrompt: `You are a helpful assistant that speaks like a pirate.
Always end responses with "Arrr!"`,
	noSession: true,
});

try {
	console.log("=== Replace prompt ===");
	await replaced.prompt("Say hello.");
	console.log();
} finally {
	await replaced.dispose();
}

const appended = await createDurableSession({
	appendSystemPrompt: ["Always answer in one sentence."],
	noSession: true,
});

try {
	console.log("=== Append prompt ===");
	await appended.prompt("Say hello.");
	console.log();
} finally {
	await appended.dispose();
}
