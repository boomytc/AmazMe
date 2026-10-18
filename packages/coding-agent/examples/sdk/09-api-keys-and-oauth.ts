/**
 * API keys.
 *
 * Saved credentials come from the model runtime. `apiKey` is a non-persistent override
 * for the provider selected with `provider` and `model`.
 */

import { createDurableSession, ModelRuntime } from "@amazme/coding-agent";

const modelRuntime = await ModelRuntime.create();
const available = await modelRuntime.getAvailable();
const selected = available[0];
if (!selected) throw new Error("No model with credentials is available.");

const session = await createDurableSession({
	modelRuntime,
	provider: selected.provider,
	model: selected.id,
	...(process.env.MY_API_KEY === undefined ? {} : { apiKey: process.env.MY_API_KEY }),
	noSession: true,
});

try {
	await session.prompt("Say hello in one sentence.");
} finally {
	await session.dispose();
}
