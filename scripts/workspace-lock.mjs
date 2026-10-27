import { spawnSync } from "node:child_process";
import { fstatSync, statSync } from "node:fs";
import { join } from "node:path";

export function heldWorkspaceLock(root) {
	const value = process.env.AMAZME_WORKSPACE_LOCK_FD;
	if (!value || !/^\d+$/.test(value)) return undefined;
	const fd = Number(value);
	try {
		const held = fstatSync(fd);
		const expected = statSync(join(root, ".artifacts", "workspace-verification.lock"));
		return held.dev === expected.dev && held.ino === expected.ino ? fd : undefined;
	} catch { return undefined; }
}

export function lockStdio(fd) {
	const stdio = Array.from({ length: Math.max(3, fd + 1) }, (_, index) => index < 3 ? "inherit" : "ignore");
	stdio[fd] = fd;
	return stdio;
}

export function runWithWorkspaceLock(root, args) {
	const helper = join(root, "backend", "tools", "workspace_lock.py");
	const result = spawnSync(process.env.AMAZME_LOCK_PYTHON || "python3", [helper, root, process.execPath, ...args], {
		cwd: root, stdio: "inherit",
	});
	if (result.error) throw result.error;
	return result.status ?? 1;
}
