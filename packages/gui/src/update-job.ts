import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNewerRelease } from "@amazme/coding-agent/update-manifest";
import type { InstallJob } from "./macos-update.ts";

export async function readInstallJob(directory: string): Promise<InstallJob> {
	const mode = await lstat(directory);
	if (!mode.isDirectory() || mode.uid !== process.getuid?.() || (mode.mode & 0o077) !== 0 || await realpath(directory) !== directory) throw new Error("permission");
	const file = join(directory, "job.json");
	if (!(await lstat(file)).isFile() || await realpath(file) !== file) throw new Error("permission");
	const value = JSON.parse(await readFile(file, "utf8")) as Partial<InstallJob>;
	if (typeof value.target !== "string" || dirname(value.target) !== dirname(directory) || !directory.startsWith(join(dirname(value.target), ".AmazMe-update-"))
		|| ![value.current, value.version].every(item => typeof item === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item))
		|| typeof value.team !== "string" || !/^[A-Z0-9]{10}$/.test(value.team)
		|| !["arm64", "x64"].includes(String(value.arch)) || typeof value.originalHash !== "string" || !/^[a-f0-9]{40,64}$/.test(value.originalHash)
		|| !Number.isSafeInteger(value.parentPid) || Number(value.parentPid) < 2 || typeof value.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(value.nonce)) throw new Error("install");
	if (!isNewerRelease(String(value.version), String(value.current))) throw new Error("install");
	return value as InstallJob;
}
