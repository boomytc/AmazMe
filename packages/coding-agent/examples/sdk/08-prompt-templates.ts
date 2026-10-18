/**
 * Prompt templates.
 *
 * Extra template files or directories are loaded beside the discovered ones.
 */

import { createDurableSession } from "@amazme/coding-agent";

const session = await createDurableSession({
	promptTemplates: ["./prompts"],
	noSession: true,
});

try {
	await session.prompt("/example");
} finally {
	await session.dispose();
}
