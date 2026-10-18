/**
 * Tool selection.
 *
 * `noTools: "all"` disables built-in and extension tools. `tools` is an allowlist.
 * The session cwd is the directory tools run in.
 */

import { createDurableSession } from "@amazme/coding-agent";

const readOnly = await createDurableSession({
	noTools: "builtin",
	noSession: true,
});
await readOnly.dispose();

const customCwd = "/tmp/amazme-sdk-tools";
const specific = await createDurableSession({
	cwd: customCwd,
	tools: ["read", "grep", "find", "ls"],
	noSession: true,
});

try {
	await specific.prompt("List the files in this directory.");
} finally {
	await specific.dispose();
}
