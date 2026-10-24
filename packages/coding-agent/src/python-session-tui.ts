/**
 * Interactive screen for one explicit Python host, session, and workspace.
 * An exact 批准 or 拒绝 is the only decision. Leaving releases this binding
 * and does not cancel accepted work or close the session terminal or MCP service.
 */

import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Component } from "@amazme/tui";
import { getAgentDir } from "./config.ts";
import { KeybindingsManager } from "./core/keybindings.ts";
import { CustomEditor } from "./modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "./modes/interactive/theme/theme.ts";
import { createInteractiveTui } from "./modes/interactive/tui-renderer.ts";
import { HostClient } from "./python-headless.ts";

export interface PythonSessionTarget {
	readonly url: string;
	readonly token: string;
	readonly workspace: string;
	readonly session?: string;
}

export interface Held {
	readonly kind: "request" | "mcp";
	readonly requestId: string;
	readonly callId: string;
	readonly summary: string;
}

interface PendingInput {
	inputId: string;
	prompt: string;
}

export interface ScreenState {
	terminalId: string;
	serverId: string;
	held: Held | null;
	pendingInput: PendingInput | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string): never {
	throw new Error(code);
}

function stopped(kind: string, view: Record<string, unknown>): string {
	const phase = typeof view.phase === "string" ? view.phase : "";
	const clean = view.clean === true;
	if (phase === "exited" && clean) return `${kind}已退出`;
	if (phase === "unknown" || !clean) return `${kind}停止未确认`;
	return `${kind}${phase}`;
}

function mcpLine(call: Record<string, unknown>): string {
	const phase = typeof call.phase === "string" ? call.phase : "failed";
	const error = typeof call.error === "string" && call.error ? ` ${call.error}` : "";
	const result = typeof call.result === "string" && call.result ? ` ${call.result}` : "";
	return `MCP ${phase}${error}${result}`;
}

function receiptLine(receipt: Record<string, unknown>): string {
	const status = typeof receipt.status === "string" ? receipt.status : "failed";
	if (status === "succeeded") return typeof receipt.answer === "string" && receipt.answer ? receipt.answer : "succeeded";
	const error = typeof receipt.error === "string" && receipt.error ? ` ${receipt.error}` : "";
	return `${status}${error}`;
}

function approvalSummary(approval: Record<string, unknown>): string {
	const call = isRecord(approval.call) ? approval.call : {};
	const name = typeof call.name === "string" ? call.name : "tool";
	let command = "";
	if (typeof call.arguments === "string") {
		try {
			const args: unknown = JSON.parse(call.arguments);
			if (isRecord(args) && typeof args.command === "string") command = args.command;
		} catch {
			command = "";
		}
	}
	return command ? `等待审批 ${name} ${command}` : `等待审批 ${name}`;
}

function visibleLines(output: string): string[] {
	return output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((line) => line.length > 0).slice(-8);
}

async function stableOutput(client: HostClient, sessionId: string, attachmentId: string, terminalId: string): Promise<string> {
	let view = await client.readTerminal(sessionId, attachmentId, terminalId);
	let last = typeof view.output_seq === "number" ? view.output_seq : 0;
	let stable = 0;
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline && stable < 3) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		view = await client.readTerminal(sessionId, attachmentId, terminalId);
		const seq = typeof view.output_seq === "number" ? view.output_seq : 0;
		if (seq === last && seq > 0) stable += 1;
		else {
			last = seq;
			stable = 0;
		}
	}
	return typeof view.output === "string" ? view.output : "";
}

async function decideHeld(client: HostClient, sessionId: string, attachmentId: string, state: ScreenState, approve: boolean): Promise<string[]> {
	const held = state.held;
	if (!held) return [];
	if (held.kind === "mcp") {
		const decided = await client.decideCall(sessionId, attachmentId, held.callId, approve);
		state.held = null;
		return [mcpLine(decided)];
	}
	const receipt = await client.decideRequest(sessionId, attachmentId, held.requestId, approve);
	state.held = null;
	return [receiptLine(receipt)];
}

export async function handleLine(client: HostClient, sessionId: string, attachmentId: string, workspace: string, state: ScreenState, prompt: string): Promise<string[]> {
	if (state.held) {
		if (prompt !== "批准" && prompt !== "拒绝") return ["先输入批准或拒绝"];
		return decideHeld(client, sessionId, attachmentId, state, prompt === "批准");
	}
	if (prompt.startsWith("/file ")) {
		return [(await client.readFile(prompt.slice("/file ".length))).replace(/\n/g, "\\n")];
	}
	if (prompt.startsWith("/checkpoint ")) {
		const digest = await client.saveCheckpoint(workspace, prompt.slice("/checkpoint ".length));
		return [`已保存 ${digest.slice(0, 12)}`];
	}
	if (prompt === "/pty-close") {
		const terminalId = state.terminalId || (await client.runningTerminal(sessionId));
		if (!terminalId) return ["没有终端"];
		const closed = await client.closeTerminal(sessionId, attachmentId, terminalId);
		state.terminalId = "";
		return [stopped("终端", closed)];
	}
	if (prompt.startsWith("/pty-size ")) {
		const terminalId = state.terminalId || (await client.runningTerminal(sessionId));
		if (!terminalId) return ["没有终端"];
		const parts = prompt.slice("/pty-size ".length).split(/\s+/);
		const cols = Number(parts[0]);
		const rows = Number(parts[1]);
		if (!Number.isInteger(cols) || !Number.isInteger(rows)) return ["尺寸无效"];
		await client.resizeTerminal(sessionId, attachmentId, terminalId, cols, rows);
		state.terminalId = terminalId;
		const view = await client.readTerminal(sessionId, attachmentId, terminalId);
		return [`终端 ${String(view.cols)} ${String(view.rows)}`];
	}
	if (prompt === "/pty-ack") {
		if (!state.pendingInput) return ["没有未确认的输入"];
		state.pendingInput = null;
		return ["已由用户核对；原输入不会重放"];
	}
	if (prompt.startsWith("/pty ")) {
		if (state.pendingInput && state.pendingInput.prompt !== prompt) {
			return ["上次输入结果未确认；先重试同一输入，或输入 /pty-ack 核对后继续。"];
		}
		const terminalId = state.terminalId || (await client.runningTerminal(sessionId)) || (await client.openTerminal(sessionId, attachmentId, workspace));
		state.terminalId = terminalId;
		const pending = state.pendingInput ?? { inputId: randomBytes(16).toString("hex"), prompt };
		state.pendingInput = pending;
		try {
			await client.writeTerminal(sessionId, attachmentId, terminalId, `${prompt.slice("/pty ".length)}\n`, pending.inputId);
		} catch (error) {
			return [error instanceof Error && error.message === "terminal_input_unconfirmed" ? "输入未确认" : error instanceof Error ? error.message : "request_failed"];
		}
		state.pendingInput = null;
		return ["输入已接收", ...visibleLines(await stableOutput(client, sessionId, attachmentId, terminalId))];
	}
	if (prompt === "/mcp-close") {
		const serverId = state.serverId || (await client.readyServer(sessionId));
		if (!serverId) return ["没有服务"];
		const closed = await client.closeMcp(sessionId, attachmentId, serverId);
		state.serverId = "";
		return [stopped("服务", closed)];
	}
	if (prompt.startsWith("/mcp-call ")) {
		const serverId = state.serverId || (await client.readyServer(sessionId));
		if (!serverId) return ["没有服务"];
		state.serverId = serverId;
		const raw = prompt.slice("/mcp-call ".length);
		const split = raw.indexOf(" ");
		if (split <= 0) return ["参数无效"];
		let args: unknown;
		try {
			args = JSON.parse(raw.slice(split + 1));
		} catch {
			return ["参数无效"];
		}
		if (!isRecord(args)) return ["参数无效"];
		const call = await client.requestMcp(sessionId, attachmentId, serverId, raw.slice(0, split), args);
		if (call.phase === "waiting_approval" && typeof call.call_id === "string") {
			state.held = { kind: "mcp", requestId: "", callId: call.call_id, summary: `等待审批 MCP ${typeof call.name === "string" ? call.name : ""}`.trim() };
			return [state.held.summary];
		}
		return [mcpLine(call)];
	}
	if (prompt.startsWith("/mcp ")) {
		const serverId = state.serverId || (await client.readyServer(sessionId)) || (await client.openMcp(sessionId, attachmentId, prompt.slice("/mcp ".length), workspace));
		state.serverId = serverId;
		return ["MCP 已连接"];
	}
	const polled = await client.submit(sessionId, workspace, attachmentId, prompt);
	const approval = polled.approval;
	if (approval && typeof approval.request_id === "string" && typeof approval.approval_id === "string") {
		state.held = {
			kind: "request",
			requestId: approval.request_id,
			callId: "",
			summary: approvalSummary(approval),
		};
		return [state.held.summary];
	}
	return [receiptLine(polled.receipt)];
}

class PythonSessionScreen implements Component {
	focused = true;
	readonly #editor: CustomEditor;
	#header: string;
	#lines: string[];

	constructor(editor: CustomEditor, header: string) {
		this.#editor = editor;
		this.#header = header;
		this.#lines = ["Ctrl-C 松开绑定并离开"];
		this.#editor.focused = true;
	}

	setHeader(header: string): void {
		this.#header = header;
	}

	addLine(line: string): void {
		this.#lines.push(line);
		if (this.#lines.length > 20) this.#lines.shift();
	}

	render(width: number): string[] {
		const clip = (line: string) => (line.length > width ? line.slice(0, width) : line);
		return [clip(this.#header), ...this.#lines.map(clip), ...this.#editor.render(width)];
	}

	handleInput(data: string): void {
		this.#editor.handleInput(data);
	}

	invalidate(): void {
		this.#editor.invalidate();
	}
}

export async function runPythonSessionTui(target: PythonSessionTarget): Promise<void> {
	if (!target.url || !target.token || !target.workspace) fail("python_target_required");
	const client = new HostClient(target.url, target.token);
	await client.bootstrap();
	const opened = target.session ? await client.attach(target.session, target.workspace) : await client.open(target.workspace);
	initTheme();
	const tui = createInteractiveTui({
		tuiMode: "regular",
		showHardwareCursor: false,
		logDirectory: getAgentDir(),
	});
	const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
	const screen = new PythonSessionScreen(
		editor,
		`会话:${opened.sessionId} 绑定:${opened.attachmentId} 工作区:${target.workspace}`,
	);
	let released = false;
	let closing = false;
	let finish = (): void => {};
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const releaseOnce = async (): Promise<void> => {
		if (released) return;
		released = true;
		await client.release(opened.sessionId, opened.attachmentId);
	};
	const leave = (): void => {
		if (closing) return;
		closing = true;
		tui.stop();
		void releaseOnce()
			.then(() => {
				process.stdout.write("已松开绑定\n");
			})
			.catch((error: unknown) => {
				process.exitCode = 1;
				process.stderr.write(`${error instanceof Error ? error.message : "release_failed"}\n`);
			})
			.finally(finish);
	};
	editor.onBeforeInput = (data) => {
		if (data !== "\x03" && data !== "\x04") return false;
		leave();
		return true;
	};
	const onSignal = (): void => leave();
	process.on("SIGINT", onSignal);
	const state: ScreenState = { terminalId: "", serverId: "", held: null, pendingInput: null };
	let busy = false;
	let queued = "";
	if (target.session) {
		const terminalId = await client.runningTerminal(opened.sessionId).catch(() => "");
		const serverId = await client.readyServer(opened.sessionId).catch(() => "");
		if (terminalId) screen.addLine("终端仍在");
		if (serverId) screen.addLine("服务仍在");
		state.terminalId = terminalId;
		state.serverId = serverId;
	}
	const runLine = (prompt: string): void => {
		busy = true;
		screen.addLine(prompt);
		tui.requestRender();
		void handleLine(client, opened.sessionId, opened.attachmentId, target.workspace, state, prompt)
			.then((lines) => {
				for (const line of lines) screen.addLine(line);
			})
			.catch((error: unknown) => {
				screen.addLine(error instanceof Error ? error.message : "request_failed");
			})
			.finally(() => {
				busy = false;
				const next = queued;
				queued = "";
				if (next) runLine(next);
				else tui.requestRender();
			});
	};
	editor.onSubmit = (text) => {
		const prompt = text.trim();
		if (!prompt) return;
		if (busy) {
			if (!queued) queued = prompt;
			return;
		}
		runLine(prompt);
	};
	tui.addChild(screen);
	tui.setFocus(screen);
	tui.start();
	try {
		await finished;
	} finally {
		process.off("SIGINT", onSignal);
		await releaseOnce();
	}
	process.exit(process.exitCode ?? 0);
}

function backendCommand(): string {
	return process.env.AMAZME_PYTHON_BACKEND || "amazme-backend";
}

async function liveUrl(readyPath: string, tokenPath: string): Promise<string> {
	if (!existsSync(readyPath) || !existsSync(tokenPath)) return "";
	try {
		const ready = JSON.parse(readFileSync(readyPath, "utf8")) as unknown;
		if (!isRecord(ready) || typeof ready.url !== "string") return "";
		const token = readFileSync(tokenPath, "utf8").trim();
		const response = await fetch(`${ready.url}/api/v1/bootstrap`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(2000),
		});
		return response.ok ? ready.url : "";
	} catch {
		return "";
	}
}

function startServe(command: string, profile: string): Promise<string> {
	const err = openSync(join(profile, "serve.err"), "a");
	let child;
	try {
		child = spawn(command, ["serve", "--profile", profile, "--port", "0"], {
			detached: true,
			stdio: ["ignore", "pipe", err],
		});
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : "";
		fail(code === "ENOENT" ? "python_backend_missing" : "python_serve_failed");
	}
	child.unref();
	const stdout = child.stdout;
	if (!stdout) fail("python_serve_failed");
	return new Promise((resolveReady, reject) => {
		let pending = "";
		let settled = false;
		const finish = (error: Error | undefined, url?: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stdout.off("data", onData);
			if (error) {
				child.kill();
				reject(error);
				return;
			}
			stdout.destroy();
			resolveReady(url ?? "");
		};
		const timer = setTimeout(() => finish(new Error("python_serve_timeout")), 30_000);
		const onData = (chunk: Buffer | string): void => {
			pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			const newline = pending.indexOf("\n");
			if (newline < 0) return;
			const line = pending.slice(0, newline);
			let ready: unknown;
			try {
				ready = JSON.parse(line);
			} catch {
				finish(new Error("python_serve_failed"));
				return;
			}
			if (!isRecord(ready) || typeof ready.url !== "string") {
				finish(new Error("python_serve_failed"));
				return;
			}
			finish(undefined, ready.url);
		};
		stdout.on("data", onData);
		child.once("error", (error: NodeJS.ErrnoException) => {
			finish(new Error(error.code === "ENOENT" ? "python_backend_missing" : "python_serve_failed"));
		});
		child.once("exit", () => finish(new Error("python_serve_failed")));
	});
}

/** Attach to an explicit host, or start the local one without deleting an existing profile. */
export async function connectPythonHost(options: {
	readonly cwd: string;
	readonly url?: string;
	readonly token?: string;
}): Promise<{ url: string; token: string }> {
	if ((options.url === undefined) !== (options.token === undefined)) fail("python_target_required");
	if (options.url && options.token) return { url: options.url, token: options.token };
	const command = backendCommand();
	const profile = join(getAgentDir(), "python-host");
	const tokenPath = join(profile, "web.token");
	const readyPath = join(profile, "ready.json");
	if (!existsSync(join(profile, "config.json"))) {
		mkdirSync(getAgentDir(), { recursive: true });
		const providerPath = join(getAgentDir(), "provider.json");
		writeFileSync(
			providerPath,
			JSON.stringify({
				provider: "faux",
				model: "faux",
				base_url: "",
				api_key: "",
				max_tokens: 2048,
				proxy: "",
				headers: {},
			}),
			{ mode: 0o600 },
		);
		const init = spawnSync(
			command,
			["init", "--profile", profile, "--workspace", resolve(options.cwd), "--provider-config", providerPath],
			{ encoding: "utf8" },
		);
		const errno = init.error as NodeJS.ErrnoException | null;
		if (errno?.code === "ENOENT") fail("python_backend_missing");
		if (init.status !== 0) fail("python_init_failed");
	}
	const existing = await liveUrl(readyPath, tokenPath);
	const url = existing || (await startServe(command, profile));
	return { url, token: readFileSync(tokenPath, "utf8").trim() };
}

/** Start or attach to the local Python host. Leaving the screen does not stop it. */
export async function runOwnedPythonInteractive(options: { readonly workspace: string; readonly cwd: string }): Promise<void> {
	if (!options.workspace) fail("workspace_required");
	const host = await connectPythonHost({ cwd: options.cwd });
	await runPythonSessionTui({ url: host.url, token: host.token, workspace: options.workspace });
}
