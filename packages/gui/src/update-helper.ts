import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isNewerRelease } from "@amazme/coding-agent/update-manifest";
import { macTool, verifyApp, writableTarget, type InstallJob } from "./macos-update.ts";
import { replaceApplication } from "./update-transaction.ts";

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}
async function waitFor(check: () => Promise<boolean> | boolean, timeout: number): Promise<void> {
	const end = Date.now() + timeout;
	while (!await check()) { if (Date.now() >= end) throw new Error("busy"); await delay(250); }
}

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

async function noOtherInstance(target: string, parent: number): Promise<void> {
	const output = await macTool("/bin/ps", ["-axww", "-o", "pid=,comm="]);
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(.+)$/.exec(line);
		if (match && Number(match[1]) !== parent && match[2] === join(target, "Contents", "MacOS", "AmazMe")) throw new Error("busy");
	}
}

async function main(directory: string): Promise<void> {
	if (process.platform !== "darwin") throw new Error("unsupported");
	const job = await readInstallJob(directory);
	const record = async (phase: string): Promise<void> => {
		await writeFile(join(directory, "status.tmp"), JSON.stringify({ phase, version: job.version, target: job.target }), { mode: 0o600 });
		await rename(join(directory, "status.tmp"), join(directory, "status.json"));
	};
	const lock = `${job.target}.update-lock`;
	try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error("busy"); }
	try {
		await writableTarget(job.target);
		await noOtherInstance(job.target, job.parentPid);
		const original = await verifyApp(job.target, job.current, job.arch, job.team);
		if (original.hash !== job.originalHash) throw new Error("busy");
		await verifyApp(join(directory, "AmazMe.app"), job.version, job.arch, job.team);
		process.stdout.write("ready\n");
		// EOF without the explicit command is cancellation. Never stage an install on ordinary app quit.
		let command = "";
		process.stdin.on("data", (chunk: Buffer) => { command = (command + chunk.toString("utf8")).slice(0, 32); });
		await waitFor(() => process.stdin.readableEnded || process.stdin.destroyed, 60_000);
		if (command !== "install\n") { await record("postponed"); return; }
		await waitFor(() => !alive(job.parentPid), 60_000);
		await noOtherInstance(job.target, 0);
		const launchEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME };
		for (const key of ["AMAZME_CODING_AGENT_DIR", "AMAZME_SERVER_DIR", "AMAZME_GUI_CWD", "AMAZME_AGENTS_HOME", "AMAZME_GUI_USER_DATA_DIR"]) {
			if (process.env[key]) launchEnv[key] = process.env[key];
		}
		const executable = join(job.target, "Contents", "MacOS", "AmazMe");
		await replaceApplication({ target: job.target, staged: join(directory, "AmazMe.app"), backup: join(directory, "Previous.app") }, {
			verifyOriginal: async () => {
				const identity = await verifyApp(job.target, job.current, job.arch, job.team);
				if (identity.hash !== job.originalHash) throw new Error("busy");
			},
			verifyCandidate: async () => { await verifyApp(join(directory, "AmazMe.app"), job.version, job.arch, job.team); },
			rename,
			record,
			async launch() {
				const child = spawn(executable, ["--amazme-update-job", directory, job.nonce], { env: launchEnv, detached: true, stdio: "ignore" });
				let failed = false;
				child.once("error", () => { failed = true; });
				child.once("exit", () => { failed = true; });
				return {
					async healthy() {
						await waitFor(async () => {
							if (failed) throw new Error("install");
							try {
								const health = JSON.parse(await readFile(join(directory, "healthy.json"), "utf8")) as Record<string, unknown>;
								return health.nonce === job.nonce && health.version === job.version && health.pid === child.pid;
							} catch { return false; }
						}, 120_000);
						child.unref();
					},
					async stop() {
						if (child.pid !== undefined && !failed) { child.kill("SIGTERM"); await waitFor(() => !alive(child.pid ?? 0), 15_000); }
					},
				};
			},
			async relaunchOriginal() {
				const child = spawn(executable, [], { env: launchEnv, detached: true, stdio: "ignore" });
				await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref();
			},
		});
	} catch {
		const status = await readFile(join(directory, "status.json"), "utf8").catch(() => "");
		if (!/"(?:rolled-back|recovery-required)"/.test(status)) await record("failed");
		throw new Error("install");
	}
	finally { await rm(lock, { recursive: true, force: true }); }
}

/** Called only after a real desktop window and its host have loaded. Never alter a user data directory. */
export async function markUpdatedDesktopHealthy(args: readonly string[], target: string, version: string): Promise<void> {
	const index = args.indexOf("--amazme-update-job");
	if (index < 0) return;
	const directory = args[index + 1];
	if (!directory) return;
	try {
		const job = await readInstallJob(directory);
		if (job.target !== target || job.version !== version || job.nonce !== args[index + 2]) return;
		await writeFile(join(directory, "healthy.json"), JSON.stringify({ nonce: job.nonce, version, pid: process.pid }), { mode: 0o600, flag: "wx" });
	} catch { /* A stale receipt is not a startup failure. The helper handles its own timeout. */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.stdin.resume();
	main(process.argv[2] ?? "").catch(() => { process.exitCode = 1; });
}
