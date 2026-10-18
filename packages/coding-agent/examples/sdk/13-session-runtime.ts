/**
 * Replacing the active session.
 *
 * Close one Durable session and open another. `continueSession` resumes the newest
 * persisted session for the directory. Branching uses `/tree` and `/fork` in the terminal.
 */

import { createDurableSession } from "@amazme/coding-agent";

const first = await createDurableSession({ cwd: process.cwd() });
await first.prompt("Remember the word cedar.");
await first.dispose();

const second = await createDurableSession({
	cwd: process.cwd(),
	continueSession: true,
});
try {
	const answer = await second.prompt("What word did I ask you to remember?");
	console.log(answer?.content);
} finally {
	await second.dispose();
}
