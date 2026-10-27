import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { heldWorkspaceLock, lockStdio, runWithWorkspaceLock } from "./workspace-lock.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const [workspace, task] = process.argv.slice(2);
if (!["@amazme/web", "@amazme/gui", "@amazme/codemode"].includes(workspace) || !["build", "clean"].includes(task)) {
	throw new Error("Unknown workspace task");
}
const lock = heldWorkspaceLock(root);
if (lock === undefined) {
	process.exitCode = runWithWorkspaceLock(root, [fileURLToPath(import.meta.url), workspace, task]);
} else {
	const cli = process.env.npm_execpath;
	const executable = cli ? process.execPath : "npm";
	const result = spawnSync(executable, [...(cli ? [cli] : []), "run", `${task}:unlocked`, "--workspace", workspace], {
		cwd: root, stdio: lockStdio(lock),
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}
