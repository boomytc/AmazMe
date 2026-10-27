/**
 * Print, JSON, and RPC for one explicit Python host, session, and workspace.
 * Finishing releases the binding and does not cancel accepted work.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { HostClient, fail, hexId, isRecord, sleep } from "../../client/host-client.ts";
import type { ImageContent, OpenedSession, PythonModelOptions, PythonRunOptions } from "../../client/types.ts";
import { connectPythonHost } from "../../connection/connection.ts";
import { getAgentDir } from "../../config.ts";
import { writeRawStdout } from "./output.ts";

export interface PythonHeadlessOptions extends PythonRunOptions, PythonModelOptions {
    readonly verbose?: boolean;
	readonly sessionDir?: string;
	readonly extensions?: readonly string[];
	readonly mode: "text" | "json" | "rpc";
	readonly workspace?: string;
	readonly cwd: string;
	readonly url?: string;
	readonly token?: string;
	readonly prompt: string;
	readonly images?: readonly ImageContent[];
	readonly session?: string;
	readonly noSession?: boolean;
	readonly selection?: "continue" | "resume";
	readonly title?: string;
	readonly decision?: string;
	readonly request?: string;
	readonly approvalId?: string;
	readonly call?: string;
}

interface PtyRetry {
	inputId: string;
	prompt: string;
	terminalId: string;
}

function terminalOutbox(profile: string, session: string, operation: "read" | "reserve" | "ack", pending?: PtyRetry, expectedId?:string): PtyRetry | boolean | null {
    const result = spawnSync(process.env.AMAZME_PYTHON_BACKEND || "amazme-backend", ["client-outbox"], {
        input:JSON.stringify({directory:join(getAgentDir(),"terminal-inputs"),profile,session,operation,pending:pending ?? null,expected_id:expectedId ?? ""}),
        encoding:"utf8", timeout:5000, maxBuffer:1024 * 1024,
    });
    if (result.error) throw result.error;
    const body:unknown = JSON.parse(result.stdout || "null");
    if (result.status !== 0) fail(isRecord(body) && typeof body.error === "string" ? body.error : "terminal_outbox_failed");
    if (body === null || typeof body === "boolean") return body;
    if (!isRecord(body) || typeof body.inputId !== "string" || typeof body.prompt !== "string" || typeof body.terminalId !== "string") fail("invalid_terminal_input");
    return {inputId:body.inputId,prompt:body.prompt,terminalId:body.terminalId};
}

function readPtyRetry(profile:string,session:string): PtyRetry | null {
    const value = terminalOutbox(profile,session,"read");
    if (typeof value === "boolean") fail("invalid_terminal_input");
    return value;
}

function storePtyRetry(profile:string,session:string,pending:PtyRetry): PtyRetry {
    const value = terminalOutbox(profile,session,"reserve",pending);
    if (!value || typeof value === "boolean") fail("invalid_terminal_input");
    return value;
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
		process.stderr.write(`${approvalSummary(approval)} session=${sessionId} request=${String(receipt.request_id)} approval=${String(approval.approval_id)}\n`);
	} else {
		process.stderr.write(
			`${status}${error} session=${sessionId} request=${String(receipt.request_id)}\n`,
		);
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
	client: Pick<HostClient,"readTerminal">,
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
	client: Pick<HostClient,"profileId" | "runningTerminal" | "openTerminal" | "readTerminal" | "writeTerminal">,
	sessionId: string,
	attachmentId: string,
	workspace: string,
	prompt: string,
	jsonMode: boolean,
): Promise<number> {
	const profile = client.profileId;
	if (prompt === "/pty-ack") {
        const pending = readPtyRetry(profile,sessionId);
		const removed = pending ? terminalOutbox(profile,sessionId,"ack",undefined,pending.inputId) === true : false;
		const text = removed ? "已由用户核对；原输入不会重放\n" : "没有未确认的输入\n";
		return emitRecord(
			{ workspace, session_id: sessionId, status: removed ? "acked" : "absent" },
			jsonMode,
			text,
			removed ? 0 : 1,
		);
	}
	const pending = readPtyRetry(profile,sessionId);
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
	const claimed = pending ?? storePtyRetry(profile,sessionId, { inputId: hexId(), prompt, terminalId });
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
	terminalOutbox(profile,sessionId,"ack",undefined,claimed.inputId);
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

async function runPrompt(client: HostClient, options: PythonHeadlessOptions & {readonly workspace:string}): Promise<number> {
	const jsonMode = options.mode === "json";
	const prompt = options.prompt;
	const decision = options.decision;
	if (!prompt && !options.images?.length && !(options.session && (options.request || (decision && options.call)))) {
		process.stderr.write("missing_prompt\n");
		return 1;
	}
	if (options.selection === "resume")
		fail("session_selection_requires_tty_use_session_id");
	const selected = options.session ??
		(options.selection === "continue"
			? await client.recent(options.workspace)
			: undefined);
	const opened = selected
		? await client.attach(selected, options.workspace)
		: await client.open(options.workspace, options.title);
	try {
		for (const warning of await client.configureModels(options,opened.sessionId)) process.stderr.write(warning + "\n");
		await client.loadExtensions(opened.sessionId, options.extensions);
		if (!prompt && options.request && !decision) {
			const polled = await client.inspectRequest(
				opened.sessionId,
				options.request,
			);
			return emitReceipt(
				options.workspace,
				opened.sessionId,
				polled.receipt,
				jsonMode,
				polled.approval,
			);
		}
		if (!prompt && options.request && decision) {
			const current = await client.inspectRequest(opened.sessionId, options.request);
			if (!current.approval) return emitReceipt(options.workspace,opened.sessionId,current.receipt,jsonMode);
			const reviewed = await client.reviewedApproval(opened.sessionId,options.request,options.approvalId);
			const receipt = await client.decideRequest(
				opened.sessionId,
				opened.attachmentId,
				options.request,
				decision === "批准",
				reviewed,
			);
			return emitReceipt(options.workspace, opened.sessionId, receipt, jsonMode,
				receipt.status === "waiting_approval" ? await client.pendingApproval(opened.sessionId,options.request) : undefined);
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
			options.request,
		);
		if (polled.approval && decision) {
			const requestId = polled.receipt.request_id;
			if (typeof requestId !== "string") fail("invalid_approval");
			process.stderr.write(`审批 session=${opened.sessionId} request=${requestId} approval=${String(polled.approval.approval_id)}\n`);
			const receipt = await client.decideRequest(opened.sessionId, opened.attachmentId, requestId, decision === "批准",polled.approval);
			return emitReceipt(options.workspace, opened.sessionId, receipt, jsonMode,
				receipt.status === "waiting_approval" ? await client.pendingApproval(opened.sessionId,requestId) : undefined);
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
	if (options.decision !== undefined && options.decision !== "批准" && options.decision !== "拒绝") {
		process.stderr.write("invalid_decision\n");
		return 1;
	}
	if (options.request !== undefined && options.call !== undefined) {
		process.stderr.write("decision_target_conflict\n");
		return 1;
	}
	if (options.decision && options.request && !options.approvalId) {
        process.stderr.write("approval_id_required\n"); return 1;
    }
    if (options.decision && (options.request || options.call) && (options.prompt || options.images?.length)) {
        process.stderr.write("decision_target_conflict\n"); return 1;
    }
	const host = await connectPythonHost({cwd:options.cwd, url:options.url, token:options.token, sessionDir:options.sessionDir,
		...(options.noSession ? {noSession:true,workspace:options.workspace} : {})});
	try {
		const client = new HostClient(host.url, host.token, options);
		await client.bootstrap();
        if (options.verbose) process.stderr.write(client.connectionInfo() + "\n");
		if (options.mode === "rpc") {
			for (const warning of await client.configureModels(options,options.session)) process.stderr.write(warning + "\n");
			if (!options.extensions?.length) return await runRpc(client);
			if (!options.session) fail("rpc_extensions_require_session");
			const opened = await client.attach(options.session, options.workspace ?? "primary");
			try {
				await client.loadExtensions(opened.sessionId, options.extensions);
				return await runRpc(client);
			} finally { await client.release(opened.sessionId, opened.attachmentId); }
		}
		const workspace = options.noSession ? "primary" : options.url
			? options.workspace ?? "primary"
			: await client.selectWorkspace(options.cwd, options.workspace);
		return await runPrompt(client, {...options, workspace});
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "python_headless_failed"}\n`);
		return 1;
	} finally { await host.close?.(); }
}
