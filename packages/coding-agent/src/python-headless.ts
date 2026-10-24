/**
 * Print, JSON, and RPC for one explicit Python host, session, and workspace.
 * Finishing releases the binding and does not cancel accepted work.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { getAgentDir } from "./config.ts";
import { writeRawStdout } from "./core/output-guard.ts";
import { connectPythonHost } from "./python-session-tui.ts";

export interface ImageContent {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

export interface PythonRunOptions {
	readonly system_prompt?: string;
	readonly append_system_prompt?: string;
	readonly allowed_tools?: readonly string[];
	readonly excluded_tools?: readonly string[];
}

export interface PythonHeadlessOptions extends PythonRunOptions {
	readonly mode: "text" | "json" | "rpc";
	readonly workspace: string;
	readonly cwd: string;
	readonly url?: string;
	readonly token?: string;
	readonly prompt: string;
	readonly images?: readonly ImageContent[];
	readonly session?: string;
	readonly decision?: string;
	readonly request?: string;
	readonly call?: string;
}

interface OpenedSession {
	readonly sessionId: string;
	readonly attachmentId: string;
}

interface Polled {
	readonly receipt: Record<string, unknown>;
	readonly approval?: Record<string, unknown>;
}

const TERMINAL = new Set(["succeeded", "cancelled", "interrupted", "failed", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string): never {
	throw new Error(code);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexId(): string {
	return randomBytes(16).toString("hex");
}

interface PtyRetry {
	inputId: string;
	prompt: string;
	terminalId: string;
}

function ptyRetryPath(sessionId: string): string {
	if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) fail("invalid_session");
	return join(getAgentDir(), "terminal-inputs", `${sessionId}.json`);
}

function readPtyRetry(sessionId: string): PtyRetry | null {
	const path = ptyRetryPath(sessionId);
	if (!existsSync(path)) return null;
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (
		!isRecord(parsed) ||
		typeof parsed.inputId !== "string" ||
		typeof parsed.prompt !== "string" ||
		typeof parsed.terminalId !== "string"
	) {
		fail("invalid_terminal_input");
	}
	return { inputId: parsed.inputId, prompt: parsed.prompt, terminalId: parsed.terminalId };
}

function storePtyRetry(sessionId: string, pending: PtyRetry): PtyRetry {
	mkdirSync(join(getAgentDir(), "terminal-inputs"), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(ptyRetryPath(sessionId), JSON.stringify(pending), { flag: "wx", mode: 0o600 });
		return pending;
	} catch (error) {
		if (!isRecord(error) || error.code !== "EEXIST") throw error;
		const current = readPtyRetry(sessionId);
		if (!current) fail("invalid_terminal_input");
		return current;
	}
}

export function clearPtyRetry(sessionId: string): boolean {
	const path = ptyRetryPath(sessionId);
	if (!existsSync(path)) return false;
	unlinkSync(path);
	return true;
}

function approvalSummary(approval: Record<string, unknown>): string {
	const call = approval.call;
	if (!isRecord(call) || typeof call.name !== "string") return "等待审批";
	let detail = "";
	if (typeof call.arguments === "string") {
		try {
			const args: unknown = JSON.parse(call.arguments);
			if (isRecord(args) && typeof args.command === "string") detail = args.command;
		} catch {
			detail = "";
		}
	}
	return detail ? `等待审批 ${call.name} ${detail}` : `等待审批 ${call.name}`;
}

function visibleLines(raw: string): string[] {
	const text = raw
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\r/g, "");
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		.slice(-8);
}

export class HostClient {
	readonly #url: string;
	readonly #token: string;
	#buildId = "";
	#hostEpoch = 0;
	readonly #runOptions: PythonRunOptions;

	constructor(url: string, token: string, options: PythonRunOptions = {}) {
		this.#url = url.replace(/\/$/, "");
		this.#token = token;
		this.#runOptions = {
			system_prompt: options.system_prompt,
			append_system_prompt: options.append_system_prompt,
			allowed_tools: options.allowed_tools,
			excluded_tools: options.excluded_tools,
		};
	}

	async bootstrap(): Promise<void> {
		const body = await this.#send("GET", "/api/v1/bootstrap");
		if (typeof body.build_id !== "string" || typeof body.host_epoch !== "number") fail("invalid_bootstrap");
		this.#buildId = body.build_id;
		this.#hostEpoch = body.host_epoch;
	}

	async open(workspace: string): Promise<OpenedSession> {
		if (!workspace) fail("workspace_required");
		const created = await this.#send("POST", "/api/v1/sessions", { title: "命令", workspace });
		if (typeof created.session_id !== "string" || created.workspace !== workspace) fail("invalid_session");
		return this.attach(created.session_id, workspace);
	}

	async attach(sessionId: string, workspace: string): Promise<OpenedSession> {
		const current = await this.#send("GET", "/api/v1/sessions");
		const sessions = current.sessions;
		if (!Array.isArray(sessions)) fail("invalid_session");
		const found = sessions.find((item) => isRecord(item) && item.session_id === sessionId);
		if (!isRecord(found)) fail("session_not_found");
		if (found.workspace !== workspace) fail("workspace_mismatch");
		const attached = await this.#send("POST", `/api/v1/sessions/${sessionId}/attachments`);
		if (typeof attached.attachment_id !== "string") fail("invalid_attachment");
		return { sessionId, attachmentId: attached.attachment_id };
	}

	async submit(
		sessionId: string,
		workspace: string,
		attachmentId: string,
		text: string,
		images: readonly ImageContent[] = [],
	): Promise<Polled> {
		await this.#requireWorkspace(sessionId, workspace);
		const requestId = randomBytes(8).toString("hex");
		await this.#send(
			"POST",
			`/api/v1/sessions/${sessionId}/submissions`,
			{
				...this.#runOptions,
				request_id: requestId,
				text,
				images: images.map((image) => ({ media_type: image.mimeType, data_base64: image.data })),
			},
			attachmentId,
		);
		return this.#untilDecision(sessionId, requestId);
	}

	async decideRequest(
		sessionId: string,
		attachmentId: string,
		requestId: string,
		approve: boolean,
	): Promise<Record<string, unknown>> {
		const approval = await this.pendingApproval(sessionId, requestId);
		if (!approval) fail("approval_not_found");
		const approvalId = approval.approval_id;
		const revision = approval.revision;
		const digest = approval.proposal_digest;
		if (typeof approvalId !== "string" || typeof revision !== "string" || typeof digest !== "string")
			fail("invalid_approval");
		await this.#send(
			"POST",
			`/api/v1/sessions/${sessionId}/approvals`,
			{
				decision_id: hexId(),
				approval_id: approvalId,
				expected_revision: revision,
				proposal_digest: digest,
				approve,
			},
			attachmentId,
		);
		return this.#untilTerminal(sessionId, requestId);
	}

	async readFile(path: string): Promise<string> {
		const body = await this.#send("GET", `/api/v1/files/content?path=${encodeURIComponent(path)}`);
		if (typeof body.content !== "string") fail("invalid_file");
		return body.content;
	}

	async saveCheckpoint(workspace: string, path: string): Promise<string> {
		const saved = await this.#send("POST", "/api/v1/checkpoints", {
			checkpoint_id: hexId(),
			workspace,
			path,
		});
		if (typeof saved.digest !== "string" || saved.digest.length === 0) fail("invalid_checkpoint");
		return saved.digest;
	}

	async runningTerminal(sessionId: string): Promise<string> {
		const listed = await this.#send("GET", `/api/v1/sessions/${sessionId}/terminals`);
		const terminals = listed.terminals;
		if (!Array.isArray(terminals)) fail("invalid_terminal");
		const running = terminals.filter(
			(item) => isRecord(item) && item.phase === "running" && typeof item.terminal_id === "string",
		);
		if (running.length > 1) fail("terminal_ambiguous");
		const first = running[0];
		return isRecord(first) && typeof first.terminal_id === "string" ? first.terminal_id : "";
	}

	async openTerminal(sessionId: string, attachmentId: string, workspace: string): Promise<string> {
		const terminalId = hexId();
		const opened = await this.#send(
			"POST",
			`/api/v1/sessions/${sessionId}/terminals`,
			{
				terminal_id: terminalId,
				command: "sh",
				cols: 80,
				rows: 24,
				workspace,
			},
			attachmentId,
		);
		if (opened.terminal_id !== terminalId || opened.phase !== "running") fail("terminal_open_failed");
		return terminalId;
	}

	async writeTerminal(
		sessionId: string,
		attachmentId: string,
		terminalId: string,
		data: string,
		inputId = hexId(),
	): Promise<void> {
		const written = await this.#send(
			"POST",
			`/api/v1/sessions/${sessionId}/terminals/${terminalId}/input`,
			{
				input_id: inputId,
				data,
			},
			attachmentId,
		);
		if (written.input_status !== "accepted") fail("terminal_input_unconfirmed");
	}

	async readTerminal(sessionId: string, attachmentId: string, terminalId: string): Promise<Record<string, unknown>> {
		return this.#send("POST", `/api/v1/sessions/${sessionId}/terminals/${terminalId}/read`, {}, attachmentId);
	}

	async resizeTerminal(
		sessionId: string,
		attachmentId: string,
		terminalId: string,
		cols: number,
		rows: number,
	): Promise<void> {
		const view = await this.#send(
			"POST",
			`/api/v1/sessions/${sessionId}/terminals/${terminalId}/resize`,
			{ cols, rows },
			attachmentId,
		);
		if (view.cols !== cols || view.rows !== rows) fail("terminal_resize_failed");
	}

	async closeTerminal(sessionId: string, attachmentId: string, terminalId: string): Promise<Record<string, unknown>> {
		return this.#send("POST", `/api/v1/sessions/${sessionId}/terminals/${terminalId}/close`, {}, attachmentId);
	}

	async readyServer(sessionId: string): Promise<string> {
		const state = await this.#send("GET", `/api/v1/sessions/${sessionId}/mcp`);
		const servers = state.servers;
		if (!Array.isArray(servers)) fail("invalid_mcp");
		const ready = servers.filter(
			(item) => isRecord(item) && item.phase === "ready" && typeof item.server_id === "string",
		);
		if (ready.length > 1) fail("mcp_ambiguous");
		const first = ready[0];
		return isRecord(first) && typeof first.server_id === "string" ? first.server_id : "";
	}

	async openMcp(sessionId: string, attachmentId: string, command: string, workspace: string): Promise<string> {
		const serverId = hexId();
		const opened = await this.#send(
			"POST",
			`/api/v1/sessions/${sessionId}/mcp`,
			{
				server_id: serverId,
				command,
				workspace,
			},
			attachmentId,
		);
		if (opened.server_id !== serverId || opened.phase !== "ready") fail("mcp_open_failed");
		return serverId;
	}

	async requestMcp(
		sessionId: string,
		attachmentId: string,
		serverId: string,
		name: string,
		args: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		return this.#send(
			"POST",
			`/api/v1/sessions/${sessionId}/mcp/${serverId}/calls`,
			{
				call_id: hexId(),
				name,
				arguments: args,
				origin: "manual",
			},
			attachmentId,
		);
	}

	async decideCall(
		sessionId: string,
		attachmentId: string,
		callId: string,
		approve: boolean,
	): Promise<Record<string, unknown>> {
		const state = await this.#send("GET", `/api/v1/sessions/${sessionId}/mcp`);
		const calls = state.calls;
		if (!Array.isArray(calls)) fail("invalid_mcp");
		const found = calls.find((item) => isRecord(item) && item.call_id === callId);
		if (!isRecord(found) || typeof found.server_id !== "string" || typeof found.digest !== "string")
			fail("mcp_call_not_found");
		if (found.phase !== "waiting_approval") fail("mcp_call_conflict");
		const decided = await this.#send(
			"POST",
			`/api/v1/sessions/${sessionId}/mcp/${found.server_id}/calls/${callId}/decision`,
			{
				decision_id: hexId(),
				approve,
				digest: found.digest,
			},
			attachmentId,
		);
		return this.#untilMcp(sessionId, callId, decided);
	}

	async closeMcp(sessionId: string, attachmentId: string, serverId: string): Promise<Record<string, unknown>> {
		return this.#send("POST", `/api/v1/sessions/${sessionId}/mcp/${serverId}/cancel`, {}, attachmentId);
	}

	async release(sessionId: string, attachmentId: string): Promise<void> {
		await this.#send("DELETE", `/api/v1/sessions/${sessionId}/attachments/${attachmentId}`, undefined, attachmentId);
	}

	async pendingApproval(sessionId: string, requestId: string): Promise<Record<string, unknown> | undefined> {
		const snapshot = await this.#send("GET", `/api/v1/sessions/${sessionId}/snapshot`);
		const approvals = snapshot.approvals;
		if (!Array.isArray(approvals)) return undefined;
		return approvals.find((item) => isRecord(item) && item.request_id === requestId && item.state === "pending");
	}

	async #requireWorkspace(sessionId: string, workspace: string): Promise<void> {
		const current = await this.#send("GET", "/api/v1/sessions");
		const sessions = current.sessions;
		if (!Array.isArray(sessions)) fail("invalid_session");
		const found = sessions.find((item) => isRecord(item) && item.session_id === sessionId);
		if (!isRecord(found)) fail("session_not_found");
		if (found.workspace !== workspace) fail("workspace_mismatch");
	}

	async #untilDecision(sessionId: string, requestId: string): Promise<Polled> {
		for (let attempt = 0; attempt < 800; attempt += 1) {
			const receipt = await this.#send("GET", `/api/v1/sessions/${sessionId}/requests/${requestId}`);
			if (typeof receipt.status === "string" && TERMINAL.has(receipt.status)) return { receipt };
			if (receipt.status === "waiting_approval") {
				const approval = await this.pendingApproval(sessionId, requestId);
				if (approval) return { receipt, approval };
			}
			await sleep(50);
		}
		fail("request_pending");
	}

	async #untilTerminal(sessionId: string, requestId: string): Promise<Record<string, unknown>> {
		for (let attempt = 0; attempt < 800; attempt += 1) {
			const receipt = await this.#send("GET", `/api/v1/sessions/${sessionId}/requests/${requestId}`);
			if (typeof receipt.status === "string" && TERMINAL.has(receipt.status)) return receipt;
			await sleep(50);
		}
		fail("request_pending");
	}

	async #untilMcp(
		sessionId: string,
		callId: string,
		current: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		let call = current;
		for (let attempt = 0; attempt < 800; attempt += 1) {
			if (call.phase === "done" || call.phase === "denied" || call.phase === "unknown" || call.phase === "conflict")
				return call;
			await sleep(50);
			const state = await this.#send("GET", `/api/v1/sessions/${sessionId}/mcp`);
			const calls = state.calls;
			if (!Array.isArray(calls)) fail("invalid_mcp");
			const found = calls.find((item) => isRecord(item) && item.call_id === callId);
			if (!isRecord(found)) fail("mcp_call_not_found");
			call = found;
		}
		fail("request_pending");
	}

	async rpc(call: unknown): Promise<unknown> {
		if (isRecord(call) && call.method === "request.submit" && isRecord(call.params))
			call = { ...call, params: { ...this.#runOptions, ...call.params } };
		return this.#sendRaw("POST", "/api/v1/rpc", call);
	}

	async #send(
		method: string,
		path: string,
		jsonBody?: Record<string, unknown>,
		attachmentId = "",
	): Promise<Record<string, unknown>> {
		const payload = await this.#sendRaw(method, path, jsonBody, attachmentId);
		if (!isRecord(payload)) fail("request_failed");
		return payload;
	}

	async #sendRaw(method: string, path: string, jsonBody?: unknown, attachmentId = ""): Promise<unknown> {
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
		if (!response.ok) {
			const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : `http_${response.status}`;
			fail(code);
		}
		return payload;
	}
}

async function emitReceipt(
	workspace: string,
	sessionId: string,
	receipt: Record<string, unknown>,
	jsonMode: boolean,
	approval?: Record<string, unknown>,
): Promise<number> {
	const status = typeof receipt.status === "string" ? receipt.status : "failed";
	const answer = typeof receipt.answer === "string" ? receipt.answer : "";
	const error = typeof receipt.error === "string" && receipt.error ? ` ${receipt.error}` : "";
	if (jsonMode) {
		const body: Record<string, unknown> = {
			workspace,
			session_id: sessionId,
			request_id: receipt.request_id,
			status,
			answer,
			error: typeof receipt.error === "string" ? receipt.error : "",
		};
		if (approval) {
			body.approval_id = approval.approval_id;
			body.revision = approval.revision;
			body.proposal_digest = approval.proposal_digest;
			body.summary = approvalSummary(approval);
		}
		await writeRawStdout(`${JSON.stringify(body)}\n`);
	} else if (status === "succeeded") {
		await writeRawStdout(`${answer}\n`);
	} else if (approval) {
		process.stderr.write(`${approvalSummary(approval)}\n`);
	} else {
		process.stderr.write(`${status}${error}\n`);
	}
	if (status === "succeeded") return 0;
	if (status === "waiting_approval") return 2;
	return 1;
}

async function emitRecord(
	payload: Record<string, unknown>,
	jsonMode: boolean,
	text: string,
	code: number,
): Promise<number> {
	if (jsonMode) await writeRawStdout(`${JSON.stringify(payload)}\n`);
	else if (code === 0) await writeRawStdout(text);
	else process.stderr.write(text);
	return code;
}

async function watchTerminal(
	client: HostClient,
	sessionId: string,
	attachmentId: string,
	terminalId: string,
): Promise<string> {
	let view = await client.readTerminal(sessionId, attachmentId, terminalId);
	let last = typeof view.output_seq === "number" ? view.output_seq : 0;
	let stable = 0;
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline && stable < 3) {
		await sleep(100);
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

export async function runPtyCommand(
	client: HostClient,
	sessionId: string,
	attachmentId: string,
	workspace: string,
	prompt: string,
	jsonMode: boolean,
): Promise<number> {
	if (prompt === "/pty-ack") {
		const removed = clearPtyRetry(sessionId);
		const text = removed ? "已由用户核对；原输入不会重放\n" : "没有未确认的输入\n";
		return emitRecord(
			{ workspace, session_id: sessionId, status: removed ? "acked" : "absent" },
			jsonMode,
			text,
			removed ? 0 : 1,
		);
	}
	const pending = readPtyRetry(sessionId);
	if (pending && pending.prompt !== prompt) {
		return emitRecord(
			{
				workspace,
				session_id: sessionId,
				status: "unknown",
				input_id: pending.inputId,
			},
			jsonMode,
			"上次输入结果未确认；先重试同一输入，或输入 /pty-ack 核对后继续。\n",
			1,
		);
	}
	let terminalId = pending?.terminalId ?? "";
	if (!terminalId) {
		terminalId = await client.runningTerminal(sessionId);
		if (!terminalId) terminalId = await client.openTerminal(sessionId, attachmentId, workspace);
	}
	const claimed = pending ?? storePtyRetry(sessionId, { inputId: hexId(), prompt, terminalId });
	if (claimed.prompt !== prompt) {
		return emitRecord(
			{
				workspace,
				session_id: sessionId,
				status: "unknown",
				input_id: claimed.inputId,
			},
			jsonMode,
			"上次输入结果未确认；先重试同一输入，或输入 /pty-ack 核对后继续。\n",
			1,
		);
	}
	try {
		await client.writeTerminal(
			sessionId,
			attachmentId,
			claimed.terminalId,
			`${prompt.slice("/pty ".length)}\n`,
			claimed.inputId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "request_failed";
		const text = message === "terminal_input_unconfirmed" ? "输入未确认\n" : `${message}\n`;
		return emitRecord(
			{
				workspace,
				session_id: sessionId,
				status: "unknown",
				input_id: claimed.inputId,
				terminal_id: claimed.terminalId,
			},
			jsonMode,
			text,
			1,
		);
	}
	clearPtyRetry(sessionId);
	const output = await watchTerminal(client, sessionId, attachmentId, claimed.terminalId);
	const text = `输入已接收\n${visibleLines(output).join("\n")}\n`;
	return emitRecord(
		{
			workspace,
			session_id: sessionId,
			status: "accepted",
			terminal_id: claimed.terminalId,
			input_id: claimed.inputId,
			output,
		},
		jsonMode,
		text,
		0,
	);
}

async function localCommand(
	client: HostClient,
	opened: OpenedSession,
	workspace: string,
	prompt: string,
	decision: string | undefined,
	jsonMode: boolean,
): Promise<number | undefined> {
	const approve = decision === "批准";
	if (prompt.startsWith("/file ")) {
		const content = await client.readFile(prompt.slice("/file ".length).trim());
		return emitRecord(
			{ workspace, session_id: opened.sessionId, status: "read", content },
			jsonMode,
			`${content.replace(/\n/g, " ")}\n`,
			0,
		);
	}
	if (prompt.startsWith("/checkpoint ")) {
		const digest = await client.saveCheckpoint(workspace, prompt.slice("/checkpoint ".length).trim());
		return emitRecord(
			{ workspace, session_id: opened.sessionId, status: "saved", digest },
			jsonMode,
			`已保存 ${digest.slice(0, 12)}\n`,
			0,
		);
	}
	if (prompt === "/pty-close") {
		const terminalId = await client.runningTerminal(opened.sessionId);
		if (!terminalId)
			return emitRecord({ workspace, session_id: opened.sessionId, status: "absent" }, jsonMode, "尚无终端\n", 1);
		const view = await client.closeTerminal(opened.sessionId, opened.attachmentId, terminalId);
		const phase = typeof view.phase === "string" ? view.phase : "unknown";
		const clean = view.clean === true;
		const label = phase === "exited" && clean ? "终端已退出\n" : "终端停止未确认\n";
		return emitRecord(
			{ workspace, session_id: opened.sessionId, status: phase, clean },
			jsonMode,
			label,
			phase === "exited" && clean ? 0 : 1,
		);
	}
	if (prompt.startsWith("/pty-size ")) {
		const terminalId = await client.runningTerminal(opened.sessionId);
		if (!terminalId)
			return emitRecord({ workspace, session_id: opened.sessionId, status: "absent" }, jsonMode, "尚无终端\n", 1);
		const [colsText, rowsText] = prompt.slice("/pty-size ".length).trim().split(/\s+/, 2);
		const cols = Number(colsText);
		const rows = Number(rowsText);
		if (!Number.isInteger(cols) || !Number.isInteger(rows)) fail("invalid_command");
		await client.resizeTerminal(opened.sessionId, opened.attachmentId, terminalId, cols, rows);
		return emitRecord(
			{ workspace, session_id: opened.sessionId, status: "resized", cols, rows },
			jsonMode,
			`终端 ${cols} ${rows}\n`,
			0,
		);
	}
	if (prompt === "/pty-ack" || prompt.startsWith("/pty ")) {
		return runPtyCommand(client, opened.sessionId, opened.attachmentId, workspace, prompt, jsonMode);
	}
	if (prompt === "/mcp-close") {
		const serverId = await client.readyServer(opened.sessionId);
		if (!serverId)
			return emitRecord({ workspace, session_id: opened.sessionId, status: "absent" }, jsonMode, "尚无服务\n", 1);
		const view = await client.closeMcp(opened.sessionId, opened.attachmentId, serverId);
		const phase = typeof view.phase === "string" ? view.phase : "unknown";
		const clean = view.clean === true;
		const label = phase === "exited" && clean ? "服务已退出\n" : "服务停止未确认\n";
		return emitRecord(
			{ workspace, session_id: opened.sessionId, status: phase, clean },
			jsonMode,
			label,
			phase === "exited" && clean ? 0 : 1,
		);
	}
	if (prompt.startsWith("/mcp-call ")) {
		const serverId = await client.readyServer(opened.sessionId);
		if (!serverId)
			return emitRecord({ workspace, session_id: opened.sessionId, status: "absent" }, jsonMode, "尚无服务\n", 1);
		const rest = prompt.slice("/mcp-call ".length).trim();
		const splitAt = rest.indexOf(" ");
		if (splitAt <= 0) fail("invalid_tool_arguments");
		const name = rest.slice(0, splitAt);
		const args: unknown = JSON.parse(rest.slice(splitAt + 1));
		if (!isRecord(args)) fail("invalid_tool_arguments");
		let call = await client.requestMcp(opened.sessionId, opened.attachmentId, serverId, name, args);
		if (call.phase === "waiting_approval" && decision) {
			if (typeof call.call_id !== "string") fail("invalid_mcp");
			call = await client.decideCall(opened.sessionId, opened.attachmentId, call.call_id, approve);
		}
		if (call.phase === "waiting_approval") {
			return emitRecord(
				{
					workspace,
					session_id: opened.sessionId,
					status: "waiting_approval",
					call_id: call.call_id,
					digest: call.digest,
					summary: `等待审批 MCP ${String(call.name)}`,
				},
				jsonMode,
				`等待审批 MCP ${String(call.name)}\n`,
				2,
			);
		}
		const label =
			call.phase === "denied"
				? "MCP denied\n"
				: call.phase === "unknown"
					? "MCP unknown\n"
					: `MCP ${String(call.phase)}\n`;
		const code = call.phase === "done" ? 0 : 1;
		return emitRecord(
			{ workspace, session_id: opened.sessionId, status: call.phase, call_id: call.call_id, result: call.result ?? "" },
			jsonMode,
			label,
			code,
		);
	}
	if (prompt.startsWith("/mcp ")) {
		const existing = await client.readyServer(opened.sessionId);
		if (existing)
			return emitRecord(
				{ workspace, session_id: opened.sessionId, status: "ready", server_id: existing },
				jsonMode,
				"服务已连接\n",
				0,
			);
		const serverId = await client.openMcp(
			opened.sessionId,
			opened.attachmentId,
			prompt.slice("/mcp ".length).trim(),
			workspace,
		);
		return emitRecord(
			{ workspace, session_id: opened.sessionId, status: "ready", server_id: serverId },
			jsonMode,
			"MCP 已连接\n",
			0,
		);
	}
	return undefined;
}

async function runPrompt(client: HostClient, options: PythonHeadlessOptions): Promise<number> {
	const jsonMode = options.mode === "json";
	const prompt = options.prompt;
	const decision = options.decision;
	if (!prompt && !(options.session && decision && (options.request || options.call))) {
		process.stderr.write("missing_prompt\n");
		return 1;
	}
	const opened = options.session
		? await client.attach(options.session, options.workspace)
		: await client.open(options.workspace);
	try {
		if (!prompt && options.request && decision) {
			const receipt = await client.decideRequest(
				opened.sessionId,
				opened.attachmentId,
				options.request,
				decision === "批准",
			);
			return emitReceipt(options.workspace, opened.sessionId, receipt, jsonMode);
		}
		if (!prompt && options.call && decision) {
			const call = await client.decideCall(opened.sessionId, opened.attachmentId, options.call, decision === "批准");
			const label =
				call.phase === "denied"
					? "MCP denied\n"
					: call.phase === "unknown"
						? "MCP unknown\n"
						: `MCP ${String(call.phase)}\n`;
			return emitRecord(
				{
					workspace: options.workspace,
					session_id: opened.sessionId,
					status: call.phase,
					call_id: call.call_id,
				},
				jsonMode,
				label,
				call.phase === "done" ? 0 : 1,
			);
		}
		const local = await localCommand(client, opened, options.workspace, prompt, decision, jsonMode);
		if (local !== undefined) return local;
		const polled = await client.submit(
			opened.sessionId,
			options.workspace,
			opened.attachmentId,
			prompt,
			options.images,
		);
		if (polled.approval && decision) {
			const requestId = polled.receipt.request_id;
			if (typeof requestId !== "string") fail("invalid_approval");
			const receipt = await client.decideRequest(opened.sessionId, opened.attachmentId, requestId, decision === "批准");
			return emitReceipt(options.workspace, opened.sessionId, receipt, jsonMode);
		}
		return emitReceipt(options.workspace, opened.sessionId, polled.receipt, jsonMode, polled.approval);
	} finally {
		await client.release(opened.sessionId, opened.attachmentId);
	}
}

async function runRpc(client: HostClient): Promise<number> {
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let response: unknown;
		try {
			response = await client.rpc(JSON.parse(trimmed) as unknown);
		} catch (error) {
			const message = error instanceof Error ? error.message : "invalid_rpc";
			response = { jsonrpc: "2.0", id: "", error: { code: -32700, message } };
		}
		await writeRawStdout(`${JSON.stringify(response)}\n`);
	}
	return 0;
}

export async function runPythonHeadless(options: PythonHeadlessOptions): Promise<number> {
	if (!options.workspace) {
		process.stderr.write("workspace_required\n");
		return 1;
	}
	if (options.decision !== undefined && options.decision !== "批准" && options.decision !== "拒绝") {
		process.stderr.write("invalid_decision\n");
		return 1;
	}
	if (options.request !== undefined && options.call !== undefined) {
		process.stderr.write("decision_target_conflict\n");
		return 1;
	}
	try {
		const host = await connectPythonHost({ cwd: options.cwd, url: options.url, token: options.token });
		const client = new HostClient(host.url, host.token, options);
		await client.bootstrap();
		if (options.mode === "rpc") return await runRpc(client);
		return await runPrompt(client, options);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "python_headless_failed"}\n`);
		return 1;
	}
}
