import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { HostClient } from "../src/python-headless.ts";
import { handleLine, type ScreenState } from "../src/python-session-tui.ts";
import { createTempDir } from "./temp-dir.ts";

const children: ChildProcess[] = [];

afterEach(() => {
	for (const child of children) child.kill();
	children.length = 0;
});

function state(): ScreenState {
	return { terminalId: "term", serverId: "", held: null, pendingInput: null };
}

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

test("the same terminal input id is written once on a real host", async () => {
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	const directory = createTempDir("amazme-screen-pty-");
	const profile = join(directory, "profile");
	const workspace = join(directory, "workspace");
	await mkdir(workspace);
	const provider = join(directory, "provider.json");
	await writeFile(provider, JSON.stringify({
		provider: "faux", model: "faux", base_url: "", api_key: "", max_tokens: 2048, proxy: "", headers: {},
	}));
	const python = join(root, "backend/.venv/bin/python");
	await new Promise<void>((resolve, reject) => {
		const init = spawn(python, ["-m", "amazme_backend", "init", "--profile", profile, "--workspace", workspace, "--provider-config", provider], { cwd: root });
		init.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`init ${code}`))));
	});
	const serve = spawn(python, ["-m", "amazme_backend", "serve", "--profile", profile, "--port", "0"], { cwd: root });
	children.push(serve);
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
	const token = (await readFile(join(profile, "web.token"), "utf8")).trim();
	const client = new HostClient(url, token);
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
		const stop = spawn(python, ["-m", "amazme_backend", "stop", "--profile", profile], { cwd: root });
		const stopped = await new Promise<{ code: number | null; output: string }>((resolve) => {
			let output = "";
			stop.stdout?.setEncoding("utf8");
			stop.stderr?.setEncoding("utf8");
			stop.stdout?.on("data", (chunk: string) => { output += chunk; });
			stop.stderr?.on("data", (chunk: string) => { output += chunk; });
			stop.on("exit", (code) => resolve({ code, output }));
		});
		expect(stopped.code).toBe(0);
		expect(stopped.output).toContain("services stopped");
	}
});
