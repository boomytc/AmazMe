import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, onTestFinished, test } from "vitest";
import { HostClient } from "../src/python-headless.ts";
import { handleLine, type ScreenState } from "../src/python-session-tui.ts";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const python = join(root, "backend/.venv/bin/python");

interface ProcessRow {
	pid: number;
	ppid: number;
	command: string;
}

export function commandOwnsProfile(command: string, profile: string): boolean {
	if (!command.includes("amazme_backend") && !command.includes("amazme-backend")) return false;
	const tokens = command.trim().split(/\s+/);
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (token === "--profile" && tokens[index + 1] === profile) return true;
		if (token === `--profile=${profile}`) return true;
	}
	return false;
}

export function ownedProcessIds(rows: ProcessRow[], profile: string, selfPid = -1): number[] {
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const direct = new Set(rows.filter((row) => commandOwnsProfile(row.command, profile)).map((row) => row.pid));
	const owned = new Set(direct);
	for (const row of rows) {
		let cursor = row.ppid;
		const seen = new Set<number>();
		while (cursor > 1 && !seen.has(cursor)) {
			seen.add(cursor);
			if (direct.has(cursor)) {
				owned.add(row.pid);
				break;
			}
			cursor = byPid.get(cursor)?.ppid ?? 0;
		}
	}
	return [...owned].filter((pid) => pid > 0 && pid !== selfPid);
}

async function processRows(): Promise<ProcessRow[]> {
	const { stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,ppid=,command="]);
	const rows: ProcessRow[] = [];
	for (const line of stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (!match) continue;
		rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" });
	}
	return rows;
}

async function remainingOwned(profile: string): Promise<number[]> {
	return ownedProcessIds(await processRows(), profile, process.pid);
}

function signalOwned(pids: number[], signal: NodeJS.Signals): void {
	for (const pid of pids) {
		try {
			process.kill(pid, signal);
		} catch {
			// The process exited between the snapshot and the signal.
		}
	}
}

async function waitGone(pids: number[], timeoutMs: number): Promise<number[]> {
	const deadline = Date.now() + timeoutMs;
	let left = pids;
	while (Date.now() < deadline) {
		const alive: number[] = [];
		for (const pid of left) {
			try {
				process.kill(pid, 0);
				alive.push(pid);
			} catch {
				// exited
			}
		}
		left = alive;
		if (left.length === 0) return [];
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return left;
}

interface OwnedHost {
	directory: string;
	profile: string;
	url: string;
	token: string;
	close: () => Promise<{ code: number | null; output: string }>;
}

async function stopHost(profile: string): Promise<{ code: number | null; output: string }> {
	const stop = spawn(python, ["-m", "amazme_backend", "stop", "--profile", profile], { cwd: root });
	return new Promise((resolve) => {
		let output = "";
		stop.stdout?.setEncoding("utf8");
		stop.stderr?.setEncoding("utf8");
		stop.stdout?.on("data", (chunk: string) => { output += chunk; });
		stop.stderr?.on("data", (chunk: string) => { output += chunk; });
		stop.on("exit", (code) => resolve({ code, output }));
	});
}

function startOwnedHost(): Promise<OwnedHost> {
	const directory = mkdtempSync(join(tmpdir(), "amazme-screen-pty-"));
	const profile = join(directory, "profile");
	const workspace = join(directory, "workspace");
	mkdirSync(workspace);
	let serve: ChildProcess | null = null;
	let closing: Promise<{ code: number | null; output: string }> | null = null;
	const close = (): Promise<{ code: number | null; output: string }> => {
		if (closing) return closing;
		closing = (async () => {
			if (!serve) {
				rmSync(directory, { recursive: true, force: true });
				return { code: 0, output: "no host" };
			}
			if (!existsSync(profile)) throw new Error("profile_removed_before_shutdown");
			const stopped = await stopHost(profile);
			if (serve.exitCode === null && serve.signalCode === null) {
				await new Promise<void>((resolve) => {
					if (serve?.exitCode !== null || serve?.signalCode !== null) {
						resolve();
						return;
					}
					const timer = setTimeout(resolve, 20_000);
					serve?.once("exit", () => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
			let leftover = await remainingOwned(profile);
			if (leftover.length > 0) {
				signalOwned(leftover, "SIGTERM");
				leftover = await waitGone(leftover, 5_000);
			}
			if (leftover.length > 0) {
				const again = await remainingOwned(profile);
				signalOwned(again.filter((pid) => leftover.includes(pid)), "SIGKILL");
				leftover = await waitGone(leftover, 2_000);
			}
			if (leftover.length > 0) throw new Error(`owned_processes_remain ${leftover.join(",")}`);
			if (!existsSync(profile)) throw new Error("profile_removed_before_shutdown");
			rmSync(directory, { recursive: true, force: true });
			return stopped;
		})();
		return closing;
	};
	onTestFinished(() => close());
	return (async () => {
		try {
			const provider = join(directory, "provider.json");
			writeFileSync(provider, JSON.stringify({
				provider: "faux", model: "faux", base_url: "", api_key: "", max_tokens: 2048, proxy: "", headers: {},
			}));
			await new Promise<void>((resolve, reject) => {
				const init = spawn(python, ["-m", "amazme_backend", "init", "--profile", profile, "--workspace", workspace, "--provider-config", provider], { cwd: root });
				init.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`init ${code}`))));
			});
			serve = spawn(python, ["-m", "amazme_backend", "serve", "--profile", profile, "--port", "0"], { cwd: root });
			const url = await new Promise<string>((resolve, reject) => {
				let pending = "";
				const timer = setTimeout(() => reject(new Error("python serve timeout")), 30_000);
				serve?.stdout?.setEncoding("utf8");
				serve?.stdout?.on("data", (chunk: string) => {
					pending += chunk;
					const line = pending.split("\n").find((item) => item.startsWith("{") && item.includes("\"url\""));
					if (line === undefined) return;
					clearTimeout(timer);
					resolve(String((JSON.parse(line) as { url: string }).url));
				});
				serve?.once("exit", () => {
					clearTimeout(timer);
					reject(new Error("python serve exited"));
				});
			});
			const token = readFileSync(join(profile, "web.token"), "utf8").trim();
			return { directory, profile, url, token, close };
		} catch (error) {
			await close();
			throw error;
		}
	})();
}

function state(): ScreenState {
	return { terminalId: "term", serverId: "", held: null, pendingInput: null };
}

test("owned shutdown matches the profile argument and not another profile", () => {
	const temp = "/private/var/folders/ab/cd/T/amazme-screen-pty-nNZ88F/profile";
	const rows = [
		{ pid: 4638, ppid: 1, command: `python -m amazme_backend supervisor --profile ${temp}` },
		{ pid: 4700, ppid: 4638, command: "python -m amazme_backend pty-gate" },
		{ pid: 80, ppid: 1, command: "amazme-backend serve --profile /Users/keep/profile" },
		{ pid: 81, ppid: 80, command: "amazme-backend worker --profile /Users/keep/profile --session s" },
	];
	expect(ownedProcessIds(rows, temp, 1)).toEqual([4638, 4700]);
	expect(commandOwnsProfile("sleep 30", temp)).toBe(false);
	expect(commandOwnsProfile(`amazme-backend supervisor --profile ${temp}-extra`, temp)).toBe(false);
});

test("the interactive screen reuses an unconfirmed terminal input", async () => {
	const writes: Array<{ id: string; data: string }> = [];
	const client = {
		async runningTerminal() {
			return "term";
		},
		async openTerminal() {
			return "term";
		},
		async readTerminal() {
			return { output: "seen", output_seq: 1, cols: 80, rows: 24 };
		},
		async writeTerminal(_sessionId: string, _attachmentId: string, _terminalId: string, data: string, inputId?: string) {
			writes.push({ id: inputId ?? "", data });
			if (writes.length === 1) throw new Error("supervisor_unavailable");
			if (writes.length === 2) throw new Error("terminal_input_unconfirmed");
		},
	} as unknown as HostClient;
	const screen = state();
	const failed = await handleLine(client, "s", "a", "primary", screen, "/pty echo hi");
	expect(failed).toEqual(["supervisor_unavailable"]);
	expect(writes).toEqual([{ id: screen.pendingInput?.inputId, data: "echo hi\n" }]);
	const blocked = await handleLine(client, "s", "a", "primary", screen, "/pty echo no");
	expect(blocked[0]).toContain("同一输入");
	expect(writes).toHaveLength(1);
	const unknown = await handleLine(client, "s", "a", "primary", screen, "/pty echo hi");
	expect(unknown).toEqual(["输入未确认"]);
	expect(writes.map((item) => item.id)).toEqual([screen.pendingInput?.inputId, screen.pendingInput?.inputId]);
	const accepted = await handleLine(client, "s", "a", "primary", screen, "/pty echo hi");
	expect(accepted[0]).toBe("输入已接收");
	expect(new Set(writes.slice(0, 3).map((item) => item.id)).size).toBe(1);
	expect(screen.pendingInput).toBeNull();
	const next = await handleLine(client, "s", "a", "primary", screen, "/pty echo next");
	expect(next[0]).toBe("输入已接收");
	expect(writes.at(-1)?.data).toBe("echo next\n");
	expect(writes.at(-1)?.id).not.toBe(writes[0]?.id);
	screen.pendingInput = { inputId: writes[0]?.id ?? "", prompt: "/pty echo hi" };
	const before = writes.length;
	const acked = await handleLine(client, "s", "a", "primary", screen, "/pty-ack");
	expect(acked[0]).toContain("不会重放");
	expect(screen.pendingInput).toBeNull();
	expect(writes).toHaveLength(before);
});

test("a failed assertion stops the owned host before removing its profile", async () => {
	const host = await startOwnedHost();
	const client = new HostClient(host.url, host.token);
	await client.bootstrap();
	const opened = await client.open("primary");
	const screen = state();
	screen.terminalId = "";
	const shown = await handleLine(client, opened.sessionId, opened.attachmentId, "primary", screen, "/pty printf SCREEN_FAIL\\n");
	expect(shown[0]).toBe("输入已接收");
	const trace: string[] = [];
	let failed = false;
	try {
		expect("mid-test").toBe("complete");
	} catch (error) {
		failed = true;
		trace.push(existsSync(host.profile) ? "profile-present" : "profile-missing");
		await host.close();
		trace.push(existsSync(host.directory) ? "directory-kept" : "directory-removed");
		expect(await remainingOwned(host.profile)).toEqual([]);
		expect(error).toBeInstanceOf(Error);
	}
	expect(failed).toBe(true);
	expect(trace).toEqual(["profile-present", "directory-removed"]);
});

test("the same terminal input id is written once on a real host", async () => {
	const host = await startOwnedHost();
	const client = new HostClient(host.url, host.token);
	try {
		await client.bootstrap();
		const opened = await client.open("primary");
		const screen = state();
		screen.terminalId = "";
		const shown = await handleLine(client, opened.sessionId, opened.attachmentId, "primary", screen, "/pty printf SCREEN_LINE\\n");
		expect(shown[0]).toBe("输入已接收");
		expect(shown.join("\n")).toContain("SCREEN_LINE");
		const terminalId = screen.terminalId;
		const inputId = randomBytes(16).toString("hex");
		await client.writeTerminal(opened.sessionId, opened.attachmentId, terminalId, "printf SCREEN_ONCE\\n", inputId);
		const once = await client.readTerminal(opened.sessionId, opened.attachmentId, terminalId);
		const first = String(once.output ?? "");
		expect(first).toContain("SCREEN_ONCE");
		const firstCount = first.split("SCREEN_ONCE").length - 1;
		await client.writeTerminal(opened.sessionId, opened.attachmentId, terminalId, "printf SCREEN_ONCE\\n", inputId);
		const again = await client.readTerminal(opened.sessionId, opened.attachmentId, terminalId);
		expect(String(again.output ?? "").split("SCREEN_ONCE").length - 1).toBe(firstCount);
		await client.closeTerminal(opened.sessionId, opened.attachmentId, terminalId);
		await client.release(opened.sessionId, opened.attachmentId);
	} finally {
		const stopped = await host.close();
		expect(stopped.code).toBe(0);
		expect(stopped.output).toContain("services stopped");
		expect(existsSync(host.directory)).toBe(false);
		expect(await remainingOwned(host.profile)).toEqual([]);
	}
});
