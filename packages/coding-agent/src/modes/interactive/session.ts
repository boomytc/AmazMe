/**
 * Interactive screen for one explicit Python host, session, and workspace.
 * An exact 批准 or 拒绝 is the only decision. Leaving releases this binding
 * and does not cancel accepted work or close the session terminal or MCP service.
 */

import { randomBytes } from "node:crypto";

import { SelectList, type Component } from "@amazme/tui";

import { HostClient, fail, isRecord } from "../../client/host-client.ts";
import type {
	ImageContent,
	PythonModelOptions,
	PythonRunOptions,
	ThinkingLevel,
} from "../../client/types.ts";
import { getAgentDir } from "../../config.ts";
import { connectPythonHost } from "../../connection/connection.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { KeybindingsManager } from "./keybindings/keybindings.ts";
import {
	getEditorTheme,
	getSelectListTheme,
	initTheme,
	loadThemeFromPath,
	setRegisteredThemes,
	setThemeJsonValidator,
} from "./theme/theme.ts";
import { createInteractiveTui } from "./tui-renderer.ts";

export interface PythonSessionTarget extends PythonRunOptions, PythonModelOptions {
    readonly verbose?: boolean;
	readonly extensions?: readonly string[];
	readonly url: string;
	readonly token: string;
	readonly workspace: string;
	readonly session?: string;
	readonly selection?: "continue" | "resume";
	readonly title?: string;
	readonly tuiMode?: "regular" | "fullscreen";
	readonly theme?: string;
	readonly themes?: readonly string[];
	readonly noThemes?: boolean;
	readonly prompt?: string;
	readonly images?: readonly ImageContent[];
}

export type Held = (
	| {readonly kind:"request"; readonly requestId:string; readonly approval:Record<string, unknown>}
	| {readonly kind:"mcp"; readonly callId:string}
) & {
	readonly summary:string;
	decision?: {readonly id:string; readonly approve:boolean};
};

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
	return `${status}${error} request=${String(receipt.request_id)}；/request ${String(receipt.request_id)} 查询原回执`;
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
	if (held.decision && held.decision.approve !== approve) return ["原决定未确认，请重试原选择或 /request 核对"];
	held.decision ??= {id:randomBytes(16).toString("hex"), approve};
	if (held.kind === "mcp") {
		const decided = await client.decideCall(sessionId, attachmentId, held.callId, approve, held.decision.id);
		state.held = null;
		return [mcpLine(decided)];
	}
	const receipt = await client.decideRequest(sessionId, attachmentId, held.requestId, approve, held.approval, held.decision.id);
	const next = receipt.status === "waiting_approval" ? await client.pendingApproval(sessionId, held.requestId) : undefined;
	state.held = next ? requestHeld(next) : null;
	return [state.held?.summary ?? receiptLine(receipt)];
}

function requestHeld(approval: Record<string, unknown>): Held {
	if (typeof approval.request_id !== "string") fail("invalid_approval");
	return {kind:"request",requestId:approval.request_id,approval,summary:approvalSummary(approval)};
}

/** An exact decision word or an explicit request lookup is the only input a hold accepts. */
function isDecisionInput(prompt: string): boolean {
	return prompt === "批准" || prompt === "拒绝" || prompt.startsWith("/request ");
}

export async function handleLine(client: HostClient, sessionId: string, attachmentId: string, workspace: string, state: ScreenState, prompt: string, images: readonly ImageContent[] = []): Promise<string[]> {
	if (state.held && !prompt.startsWith("/request ")) {
		if (prompt !== "批准" && prompt !== "拒绝") return ["先输入批准或拒绝"];
		return decideHeld(client, sessionId, attachmentId, state, prompt === "批准");
	}
	if (prompt.startsWith("/thinking ")) {
		const level = prompt.slice("/thinking ".length).trim();
		const levels: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		if (!levels.includes(level)) return ["推理等级：off minimal low medium high xhigh max"];
		client.setThinking(level as ThinkingLevel);
		return [`下一回合推理等级：${level}；按模型能力调整`];
	}
	if (prompt === "/model next") return [`模型：${await client.cycleModel(sessionId)}`];
	if (prompt.startsWith("/model ")) {
		const warnings = await client.configureModels({modelRef:prompt.slice("/model ".length).trim()},sessionId);
		return [...warnings,"已选择下一回合模型"];
	}
	if (prompt === "/skills" || prompt === "/prompts" || prompt === "/context") {
		const resources = await client.resources(sessionId);
		const key = prompt === "/skills" ? "skills" : prompt === "/prompts" ? "prompts" : "context_files";
		const items = resources[key];
		if (!Array.isArray(items) || !items.length) return ["没有资源"];
		return items.map((item: unknown) => typeof item === "string" ? item : isRecord(item) ? `${String(item.name)} · ${String(item.path)}` : "");
	}
	if (prompt.startsWith("/request ")) {
		const requestId = prompt.slice("/request ".length).trim();
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) return ["请求编号无效"];
		const polled = await client.inspectRequest(sessionId, requestId);
		if (polled.approval) {
			state.held = requestHeld(polled.approval);
			return [state.held.summary];
		}
		if (state.held?.kind === "request" && state.held.requestId === requestId) state.held = null;
		return [receiptLine(polled.receipt)];
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
			state.held = { kind: "mcp", callId: call.call_id, summary: `等待审批 MCP ${typeof call.name === "string" ? call.name : ""}`.trim() };
			return [state.held.summary];
		}
		return [mcpLine(call)];
	}
	if (prompt.startsWith("/mcp ")) {
		const serverId = state.serverId || (await client.readyServer(sessionId)) || (await client.openMcp(sessionId, attachmentId, prompt.slice("/mcp ".length), workspace));
		state.serverId = serverId;
		return ["MCP 已连接"];
	}
	const polled = await client.submit(sessionId, workspace, attachmentId, prompt, images);
	const approval = polled.approval;
	if (approval && typeof approval.request_id === "string" && typeof approval.approval_id === "string") {
		state.held = requestHeld(approval);
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
		const clip = (line: string) =>
			line.length > width ? line.slice(0, width) : line;
		return [clip(this.#header), ...this.#lines.map(clip), ...this.#editor.render(width)];
	}

	handleInput(data: string): void {
		this.#editor.handleInput(data);
	}

	invalidate(): void {
		this.#editor.invalidate();
	}
}

/** Only locally queued prompts count against this bound; accepted work stays in Python. */
export class PendingPrompts {
	readonly #items: string[] = [];
	#bytes = 0;
	get length(): number {
		return this.#items.length;
	}
	push(prompt: string): boolean {
		const bytes = Buffer.byteLength(prompt);
		if (this.#items.length >= 32 || this.#bytes + bytes > 64 * 1024)
			return false;
		this.#items.push(prompt);
		this.#bytes += bytes;
		return true;
	}
	shift(): string | undefined {
		const prompt = this.#items.shift();
		if (prompt !== undefined) this.#bytes -= Buffer.byteLength(prompt);
		return prompt;
	}
	peek(): string | undefined {
		return this.#items[0];
	}
}

async function selectSession(
	client: HostClient,
	target: PythonSessionTarget,
): Promise<string | undefined | null> {
	if (target.session) return target.session;
	if (target.selection === "continue") return client.recent(target.workspace);
	if (target.selection !== "resume") return undefined;
	const sessions = (await client.listSessions(target.workspace))
		.filter((item) => !item.archived)
		.reverse();
	if (!sessions.length) return undefined;
	const picker = createInteractiveTui({
		tuiMode: target.tuiMode ?? "regular",
		showHardwareCursor: false,
		logDirectory: getAgentDir(),
	});
	const list = new SelectList(
		sessions.map((item) => ({
			value: item.session_id,
			label: item.title,
			description: item.session_id,
		})),
		12,
		getSelectListTheme(),
	);
	try {
		return await new Promise<string | null>((resolveSelected) => {
			list.onSelect = (item) => resolveSelected(item.value);
			list.onCancel = () => resolveSelected(null);
			picker.addChild(list);
			picker.setFocus(list);
			picker.start();
		});
	} finally {
		picker.stop();
	}
}

export async function configureTuiThemes(options: Pick<PythonSessionTarget, "theme" | "themes" | "noThemes">): Promise<void> {
	if (options.themes?.length) {
		const { validateThemeJson } = await import("./theme/theme-schema.ts");
		setThemeJsonValidator(validateThemeJson);
	}
	setRegisteredThemes(options.noThemes || options.themes?.length ? (options.themes ?? []).map(path => loadThemeFromPath(path)) : undefined, !options.noThemes);
	initTheme(options.theme);
}

export async function runPythonSessionTui(target: PythonSessionTarget): Promise<void> {
	if (!target.url || !target.token || !target.workspace) fail("python_target_required");
	const client = new HostClient(target.url, target.token, target);
	await client.bootstrap();
	await configureTuiThemes(target);
	const selected = await selectSession(client, target);
	if (selected === null) return;
	const opened = selected
		? await client.attach(selected, target.workspace) : await client.open(target.workspace, target.title);
	const tui = createInteractiveTui({
		tuiMode: target.tuiMode ?? "regular",
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
	const finished = new Promise<void>((resolveFinished) => {
		finish = resolveFinished;
	});
	if (target.verbose) screen.addLine(client.connectionInfo());
	const queued = new PendingPrompts();
	let initialPending = target.prompt || target.images?.length ? {text:target.prompt ?? "", images:target.images ?? []} : null;
	const releaseOnce = async (): Promise<void> => {
		if (released) return;
		released = true;
		await client.release(opened.sessionId, opened.attachmentId);
	};
	const leave = (): void => {
		if (closing) return;
		closing = true;
		tui.stop();
		const unsent = queued.length + (initialPending ? 1 : 0);
		if (unsent) process.stderr.write(`离开前尚有 ${unsent} 条输入未提交\n`);
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
	const runLine = (prompt: string, images: readonly ImageContent[] = []): void => {
		if (closing) return;
		busy = true;
		screen.addLine(prompt);
		tui.requestRender();
		void handleLine(client, opened.sessionId, opened.attachmentId, target.workspace, state, prompt, images)
			.then((lines) => {
				if (!closing) for (const line of lines) screen.addLine(line);
			})
			.catch((error: unknown) => {
				if (!closing)
					screen.addLine(error instanceof Error ? error.message : "request_failed");
			})
			.finally(() => {
				busy = false;
				drain();
			});
	};
	const drain = (): void => {
		if (closing || busy) return;
		if (state.held) {
			// A decision typed while a request was finishing stays queued until the hold appears;
			// apply it there instead of leaving the queue stranded behind the hold forever.
			const decision = queued.peek();
			if (decision === undefined || !isDecisionInput(decision)) {
				tui.requestRender();
				return;
			}
			queued.shift();
			runLine(decision);
			return;
		}
		if (initialPending) {
			const initial = initialPending;
			initialPending = null;
			runLine(initial.text, initial.images);
			return;
		}
		const next = queued.shift();
		if (next !== undefined) runLine(next);
		else tui.requestRender();
	};
	editor.onSubmit = (text) => {
		const prompt = text.trim();
		if (!prompt || closing) return;
		if (state.held && busy && isDecisionInput(prompt)) {
			editor.setText(prompt);
			screen.addLine("正在核对本次决定，请等待回执");
			tui.requestRender();
			return;
		}
		if (busy) {
			if (!queued.push(prompt)) {
				editor.setText(prompt);
				screen.addLine("待发送队列已满，输入留在编辑器中；请稍后提交");
			} else screen.addLine(`已排队 ${queued.length} 条`);
			tui.requestRender();
			return;
		}
		runLine(prompt);
	};
	try {
		for (const warning of await client.configureModels(target,opened.sessionId)) screen.addLine(warning);
		await client.loadExtensions(opened.sessionId, target.extensions);
		if (selected) {
			const snapshot = await client.snapshot(opened.sessionId);
			if (Array.isArray(snapshot.requests))
				for (const item of snapshot.requests) {
					if (!isRecord(item)) continue;
					if (typeof item.text === "string") screen.addLine(item.text);
					screen.addLine(receiptLine(item));
				}
			const approvals = Array.isArray(snapshot.approvals)
				? snapshot.approvals
				: [];
			const pending = approvals.find(
				(item) => isRecord(item) && item.state === "pending",
			);
			if (isRecord(pending) && typeof pending.request_id === "string") {
				state.held = requestHeld(pending);
				screen.addLine(state.held.summary);
			}
			state.terminalId = await client.runningTerminal(opened.sessionId);
			state.serverId = await client.readyServer(opened.sessionId);
			if (state.terminalId) screen.addLine("终端仍在");
			if (state.serverId) screen.addLine("服务仍在");
		}
		if (!closing) {
			tui.addChild(screen);
			tui.setFocus(screen);
			tui.start();
			if (initialPending && state.held) screen.addLine("审批完成后将提交首条输入");
			drain();
		}
		await finished;
	} finally {
		closing = true;
		tui.stop();
		process.off("SIGINT", onSignal);
		await releaseOnce();
	}
}

export async function runOwnedPythonInteractive(options: Omit<PythonSessionTarget, "url" | "token" | "workspace"> & {
	readonly cwd:string;
	readonly workspace?:string;
	readonly noSession?:boolean;
	readonly sessionDir?:string;
}): Promise<void> {
	const host = await connectPythonHost({cwd:options.cwd, sessionDir:options.sessionDir, ...(options.noSession ? {noSession:true,workspace:options.workspace} : {})});
	try {
		const client = new HostClient(host.url, host.token);
		await client.bootstrap();
		const workspace = options.noSession ? "primary" : await client.selectWorkspace(options.cwd, options.workspace);
		await runPythonSessionTui({...options, url:host.url, token:host.token, workspace});
	} finally { await host.close?.(); }
}
