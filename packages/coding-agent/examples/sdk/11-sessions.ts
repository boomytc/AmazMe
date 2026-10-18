/**
 * Durable sessions.
 *
 * `noSession` keeps the conversation in memory. Omit it to persist under the Durable
 * session directory. `continueSession` resumes the newest session for `cwd`.
 * `sessionDir` overrides that directory. Forking is `/fork` inside the terminal.
 */

import { createDurableSession } from "@amazme/coding-agent";

const ephemeral = await createDurableSession({ noSession: true });
await ephemeral.prompt("Remember the number 4.");
await ephemeral.dispose();

const created = await createDurableSession({ cwd: process.cwd() });
await created.prompt("Remember the number 7.");
await created.dispose();

const continued = await createDurableSession({
	cwd: process.cwd(),
	continueSession: true,
});
try {
	await continued.prompt("What number did I ask you to remember?");
} finally {
	await continued.dispose();
}
