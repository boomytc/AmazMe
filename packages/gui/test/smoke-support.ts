import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const exec = promisify(execFile);
export function electronBinary(): string {
	const value: unknown = require("electron");
	if (typeof value !== "string" || value.length === 0) throw new Error("electron did not resolve to a binary path");
	return value;
}

export function smokeEnvironment(scratch: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !/KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|^AWS_|^AZURE_|^GOOGLE_|^ELECTRON_RUN_AS_NODE$/iu.test(key)) env[key] = value;
	}
	return { ...env, AMAZME_GUI_SMOKE: "1", AMAZME_GUI_SMOKE_DATA_DIR: scratch,
		AMAZME_GUI_CWD: scratch,
		AMAZME_SERVER_DIR: join(scratch, "server"), AMAZME_CODING_AGENT_DIR: join(scratch, "agent"),
		AMAZME_GUI_READY_TIMEOUT_MS: "120000" };
}

export interface ProcessRow { pid: number; ppid: number; command: string }
export async function processRows(): Promise<ProcessRow[]> {
	const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
	return stdout.split("\n").flatMap((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
		return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }] : [];
	});
}
export function processTree(rows: readonly ProcessRow[], root: number): ProcessRow[] {
	const ids = new Set([root]);
	let size = 0;
	while (size !== ids.size) {
		size = ids.size;
		for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid);
	}
	return rows.filter((row) => ids.has(row.pid));
}
export function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}
export async function waitFor(condition: () => boolean | Promise<boolean>, detail: () => string, timeout = 15_000): Promise<void> {
	const deadline = Date.now() + timeout;
	do {
		if (await condition()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
	} while (Date.now() < deadline);
	throw new Error(detail());
}
