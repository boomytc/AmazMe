/**
 * Skills.
 *
 * Extra skill files or directories are loaded beside the discovered ones.
 * `noSkills` skips discovery.
 */

import { createDurableSession } from "@amazme/coding-agent";

const session = await createDurableSession({
	skills: ["./skills"],
	noSession: true,
});

try {
	await session.prompt("List the skills you can use.");
} finally {
	await session.dispose();
}
