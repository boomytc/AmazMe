/**
 * Interactive screen for one explicit Python host, session, and workspace.
 * Leaving releases this binding and does not cancel accepted work.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Component } from "@amazme/tui";
import { getAgentDir } from "./config.ts";
import { KeybindingsManager } from "./core/keybindings.ts";
import { CustomEditor } from "./modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "./modes/interactive/theme/theme.ts";
import { createInteractiveTui } from "./modes/interactive/tui-renderer.ts";

export interface PythonSessionTarget {
	readonly url: string;
	readonly token: string;
	readonly workspace: string;
}

interface Identity {
	readonly buildId: string;
	readonly hostEpoch: number;
}

interface OpenedSession {
	readonly sessionId: string;
	readonly attachmentId: string;
}

const TERMINAL = new Set(["succeeded", "cancelled", "interrupted", "failed", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string): never {
	throw new Error(code);
}

class PythonClient {
	readonly #url: string;
	readonly #token: string;
	#buildId = "";
	#hostEpoch = 0;

	constructor(target: PythonSessionTarget) {
		this.#url = target.url.replace(/\/$/, "");
		this.#token = target.token;
	}

	async bootstrap(): Promise<Identity> {
		const body = await this.#send("GET", "/api/v1/bootstrap");
		if (typeof body.build_id !== "string" || typeof body.host_epoch !== "number") fail("invalid_bootstrap");
		this.#buildId = body.build_id;
		this.#hostEpoch = body.host_epoch;
		return { buildId: body.build_id, hostEpoch: body.host_epoch };
	}

	async open(workspace: string): Promise<OpenedSession> {
		if (!workspace) fail("workspace_required");
		const created = await this.#send("POST", "/api/v1/sessions", { title: "终端", workspace });
		if (typeof created.session_id !== "string" || created.workspace !== workspace) fail("invalid_session");
		const attached = await this.#send("POST", `/api/v1/sessions/${created.session_id}/attachments`);
		if (typeof attached.attachment_id !== "string") fail("invalid_attachment");
		return { sessionId: created.session_id, attachmentId: attached.attachment_id };
	}

	async submit(sessionId: string, workspace: string, attachmentId: string, text: string): Promise<string> {
		const current = await this.#send("GET", "/api/v1/sessions");
		const sessions = current.sessions;
		if (!Array.isArray(sessions)) fail("invalid_session");
		const found = sessions.find((item) => isRecord(item) && item.session_id === sessionId);
		if (!isRecord(found)) fail("session_not_found");
		if (found.workspace !== workspace) fail("workspace_mismatch");
		const requestId = randomBytes(8).toString("hex");
		await this.#send(
			"POST",
			`/api/v1/sessions/${sessionId}/submissions`,
			{ request_id: requestId, text },
			attachmentId,
		);
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const receipt = await this.#send("GET", `/api/v1/sessions/${sessionId}/requests/${requestId}`);
			if (typeof receipt.status === "string" && TERMINAL.has(receipt.status)) {
				if (receipt.status === "succeeded" && typeof receipt.answer === "string") return receipt.answer;
				return receipt.status;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		fail("request_pending");
	}

	async release(sessionId: string, attachmentId: string): Promise<void> {
		await this.#send("DELETE", `/api/v1/sessions/${sessionId}/attachments/${attachmentId}`, undefined, attachmentId);
	}

	async #send(method: string, path: string, jsonBody?: Record<string, unknown>, attachmentId = ""): Promise<Record<string, unknown>> {
		const headers: Record<string, string> = { Authorization: `Bearer ${this.#token}` };
		if (jsonBody !== undefined) headers["Content-Type"] = "application/json";
		if (method !== "GET" && method !== "HEAD") {
			headers["x-amazme-build"] = this.#buildId;
			headers["x-amazme-epoch"] = String(this.#hostEpoch);
			if (attachmentId) headers["x-amazme-attachment"] = attachmentId;
		}
		const response = await fetch(`${this.#url}${path}`, {
			method,
			headers,
			body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
		});
		const payload: unknown = await response.json();
		if (!isRecord(payload)) fail("request_failed");
		if (!response.ok) fail(typeof payload.code === "string" ? payload.code : `http_${response.status}`);
		return payload;
	}
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
	const client = new PythonClient(target);
	await client.bootstrap();
	const opened = await client.open(target.workspace);
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
	editor.onSubmit = (text) => {
		const prompt = text.trim();
		if (!prompt) return;
		screen.addLine("正在等待");
		tui.requestRender();
		void client
			.submit(opened.sessionId, target.workspace, opened.attachmentId, prompt)
			.then((answer) => {
				screen.addLine(prompt);
				screen.addLine(answer);
				tui.requestRender();
			})
			.catch((error: unknown) => {
				screen.addLine(error instanceof Error ? error.message : "request_failed");
				tui.requestRender();
			});
	};
	const onSignal = (): void => leave();
	process.on("SIGINT", onSignal);
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
