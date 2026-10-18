/**
 * Context files.
 *
 * AGENTS.md and CLAUDE.md are discovered from the cwd unless `noContextFiles` is set.
 */

import { createDurableSession } from "@amazme/coding-agent";

const session = await createDurableSession({
	noContextFiles: true,
	noSession: true,
});

try {
	await session.prompt("Do you have project instructions?");
} finally {
	await session.dispose();
}
