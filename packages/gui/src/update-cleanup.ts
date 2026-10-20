import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readInstallJob } from "./update-job.ts";
import type { PreparedUpdate } from "./update-controller.ts";
import type { InstallJob } from "./macos-update.ts";

async function absent(path: string): Promise<boolean> {
	try { await lstat(path); return false; }
	catch (error) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
}
/** Before handoff the GUI owns staging. Any lock or transaction evidence transfers cleanup ownership. */
export async function discardPreparedUpdate(prepared: PreparedUpdate): Promise<"removed" | "retained"> {
	let job: InstallJob;
	try { job = await readInstallJob(prepared.directory); } catch { return "retained"; }
	if (!await absent(job.target + ".update-lock") || !await absent(join(prepared.directory, "Previous.app"))) return "retained";
	const status = join(prepared.directory, "status.json");
	if (!await absent(status)) {
		try {
			const value = JSON.parse(await readFile(status, "utf8")) as Record<string, unknown>;
			if (!["failed", "postponed"].includes(String(value.phase))) return "retained";
		} catch { return "retained"; }
	}
	await rm(prepared.directory, { recursive: true, force: true });
	return "removed";
}
