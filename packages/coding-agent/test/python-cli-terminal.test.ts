import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { HostClient, runPtyCommand } from "../src/python-headless.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const python = join(root, "backend/.venv/bin/python");
const directories: string[] = [];

afterEach(() => {
	delete process.env.AMAZME_CODING_AGENT_DIR;
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function agentDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "amazme-cli-pty-"));
	directories.push(directory);
	process.env.AMAZME_CODING_AGENT_DIR = directory;
	return directory;
}

test("a failed CLI retry keeps its input id and a later command is new", async () => {
	agentDir();
	const writes: Array<{ id?: string; data: string }> = [];
	const client = {
		async runningTerminal() {
			return "term";
		},
		async openTerminal() {
			return "term";
		},
		async readTerminal() {
			return { output: "seen", output_seq: 1 };
		},
		async writeTerminal(_session: string, _attachment: string, _terminal: string, data: string, inputId?: string) {
			writes.push({ id: inputId, data });
			if (writes.length === 1) throw new Error("terminal_input_unconfirmed");
			if (writes.length === 2) throw new Error("supervisor_unavailable");
		},
	} as unknown as HostClient;
	const unknown = await runPtyCommand(client, "session", "attach", "primary", "/pty echo hi", false);
	expect(unknown).toBe(1);
	expect(writes.map((item) => item.id)).toEqual([writes[0]?.id]);
	const blocked = await runPtyCommand(client, "session", "attach", "primary", "/pty echo no", false);
	expect(blocked).toBe(1);
	expect(writes).toHaveLength(1);
	const again = await runPtyCommand(client, "session", "attach", "primary", "/pty echo hi", false);
	expect(again).toBe(1);
	expect(writes[1]?.id).toBe(writes[0]?.id);
	const accepted = await runPtyCommand(client, "session", "attach", "primary", "/pty echo hi", false);
	expect(accepted).toBe(0);
	expect(writes[2]?.id).toBe(writes[0]?.id);
	const fresh = await runPtyCommand(client, "session", "attach", "primary", "/pty echo hi", false);
	expect(fresh).toBe(0);
	expect(writes[3]?.id).not.toBe(writes[0]?.id);
	expect(writes[3]?.data).toBe("echo hi\n");
	expect(await runPtyCommand(client, "session", "attach", "primary", "/pty-ack", false)).toBe(1);
	expect(writes).toHaveLength(4);
});

test("the same CLI retry does not write a real terminal twice", async () => {
	const directory = agentDir();
	const profile = join(directory, "profile");
	const workspace = join(directory, "workspace");
	mkdirSync(workspace);
	writeFileSync(join(directory, "provider.json"), JSON.stringify({
		provider: "faux", model: "faux", base_url: "", api_key: "", max_tokens: 2048, proxy: "", headers: {},
	}));
	const provider = join(directory, "provider.json");
	await new Promise<void>((resolve, reject) => {
		const init = spawn(python, ["-m", "amazme_backend", "init", "--profile", profile, "--workspace", workspace, "--provider-config", provider], { cwd: root });
		init.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`init ${code}`))));
	});
	const serve = spawn(python, ["-m", "amazme_backend", "serve", "--profile", profile, "--port", "0"], { cwd: root });
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		if (!existsSync(profile)) throw new Error("profile_removed_before_shutdown");
		const stop = spawn(python, ["-m", "amazme_backend", "stop", "--profile", profile], { cwd: root });
		const code = await new Promise<number | null>((resolve) => stop.on("exit", resolve));
		if (code !== 0) throw new Error(`stop ${code}`);
		if (serve.exitCode === null && serve.signalCode === null) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 20_000);
				serve.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	};
	onTestFinished(close);
	const url = await new Promise<string>((resolve, reject) => {
		let pending = "";
		const timer = setTimeout(() => reject(new Error("python serve timeout")), 30_000);
		serve.stdout?.setEncoding("utf8");
		serve.stdout?.on("data", (chunk: string) => {
			pending += chunk;
			const line = pending.split("\n").find((item) => item.startsWith("{") && item.includes("\"url\""));
			if (line === undefined) return;
			clearTimeout(timer);
			resolve(String((JSON.parse(line) as { url: string }).url));
		});
	});
	const token = readFileSync(join(profile, "web.token"), "utf8").trim();
	const client = new HostClient(url, token);
	await client.bootstrap();
	const opened = await client.open("primary");
	const prompt = "/pty printf CLI_MARK";
	expect(await runPtyCommand(client, opened.sessionId, opened.attachmentId, "primary", prompt, false)).toBe(0);
	const terminalId = (await client.runningTerminal(opened.sessionId));
	const inputId = randomBytes(16).toString("hex");
	await client.writeTerminal(opened.sessionId, opened.attachmentId, terminalId, "printf CLI_MARK\n", inputId);
	const once = String((await client.readTerminal(opened.sessionId, opened.attachmentId, terminalId)).output ?? "");
	const count = once.split("CLI_MARK").length - 1;
	expect(count).toBeGreaterThan(0);
	writeFileSync(join(directory, "terminal-inputs", `${opened.sessionId}.json`), JSON.stringify({
		inputId, prompt, terminalId,
	}));
	expect(await runPtyCommand(client, opened.sessionId, opened.attachmentId, "primary", prompt, false)).toBe(0);
	const again = String((await client.readTerminal(opened.sessionId, opened.attachmentId, terminalId)).output ?? "");
	expect(again.split("CLI_MARK").length - 1).toBe(count);
	expect(existsSync(join(directory, "terminal-inputs", `${opened.sessionId}.json`))).toBe(false);
	writeFileSync(join(directory, "terminal-inputs", `${opened.sessionId}.json`), JSON.stringify({
		inputId, prompt, terminalId,
	}));
	expect(await runPtyCommand(client, opened.sessionId, opened.attachmentId, "primary", "/pty printf CLI_OTHER", false)).toBe(1);
	const held = String((await client.readTerminal(opened.sessionId, opened.attachmentId, terminalId)).output ?? "");
	expect(held.split("CLI_MARK").length - 1).toBe(count);
	expect(held.includes("CLI_OTHER")).toBe(false);
	expect(await runPtyCommand(client, opened.sessionId, opened.attachmentId, "primary", "/pty-ack", false)).toBe(0);
	expect(await runPtyCommand(client, opened.sessionId, opened.attachmentId, "primary", prompt, false)).toBe(0);
	const newer = String((await client.readTerminal(opened.sessionId, opened.attachmentId, terminalId)).output ?? "");
	expect(newer.split("CLI_MARK").length - 1).toBeGreaterThan(count);
	await client.closeTerminal(opened.sessionId, opened.attachmentId, terminalId);
	await client.release(opened.sessionId, opened.attachmentId);
	await close();
}, 30_000);
