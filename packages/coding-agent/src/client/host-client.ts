/**
 * HTTP client for one explicit Python host. Request headers, response validation,
 * and error codes stay here; presentation modes read the returned records.
 */

import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";

import type {
	ImageContent,
	OpenedSession,
	Polled,
	PythonModelOptions,
	PythonRunOptions,
	SessionSummary,
	ThinkingLevel,
} from "./types.ts";

export class HostRequestError extends Error {
	readonly status: number;
	constructor(status: number, code: string) {
		super(code);
		this.status = status;
	}
}

const TERMINAL = new Set(["succeeded", "cancelled", "interrupted", "failed", "unknown"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fail(code: string): never {
	throw new Error(code);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hexId(): string {
	return randomBytes(16).toString("hex");
}

export class HostClient {
	readonly #url: string;
	readonly #token: string;
	#buildId = "";
	#hostEpoch = 0;
	#profileId = "";
	readonly #runOptions: Omit<PythonRunOptions, "thinking" | "model_selection"> & {
		thinking?: ThinkingLevel; model_selection?: {provider:string;model:string}};
	#scope: Array<{provider:string;model:string;thinking?:ThinkingLevel}> = [];
	#thinkingOverride: boolean;

	constructor(url: string, token: string, options: PythonRunOptions = {}) {
		this.#url = url.replace(/\/$/, "");
		this.#token = token;
		this.#thinkingOverride = options.thinking !== undefined;
		this.#runOptions = {
            model_selection: options.model_selection,
            thinking: options.thinking,
	        resource_options: options.resource_options,
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
		this.#profileId = typeof body.profile_id === "string" ? body.profile_id : "";
	}

	get profileId(): string {
        if (!this.#profileId) fail("invalid_bootstrap");
        return this.#profileId;
    }

	connectionInfo(): string {
        return `Python ${JSON.stringify({profile:this.#profileId,build:this.#buildId,epoch:this.#hostEpoch})}`;
    }

	async windowUrl(workspace: string): Promise<string> {
		if (!this.#profileId) fail("invalid_bootstrap");
		const opened = await this.open(workspace, "窗口任务");
		await this.release(opened.sessionId, opened.attachmentId);
		const url = new URL(this.#url + "/");
		url.search = new URLSearchParams({host:this.#profileId, session:opened.sessionId, workspace}).toString();
		return url.href;
	}

	async loadExtensions(sessionId: string, entries: readonly string[] = []): Promise<void> {
		if (!entries.length) return;
		const listed = await this.#send("GET", `/api/v1/plugins?session_id=${sessionId}`);
		if (!Array.isArray(listed.plugins)) fail("invalid_plugins");
		for (const entry of new Set(entries)) {
			const pluginId = createHash("sha256").update(`${sessionId}\n${entry}`).digest("hex").slice(0,32);
			const existing = listed.plugins.find((item) => isRecord(item) && item.plugin_id === pluginId);
			let view: Record<string, unknown>;
			if (isRecord(existing)) view = existing;
			else {
				try {
					view = await this.#send("POST", "/api/v1/plugins", {
						session_id:sessionId, plugin_id:pluginId,
						name:basename(entry).replace(/[^A-Za-z0-9_-]/g,"_").slice(0,64) || "plugin", entry,
					});
				} catch (error) {
					if (error instanceof HostRequestError && error.status < 500) throw error;
					throw new Error(`plugin_load_unconfirmed session=${sessionId} plugin=${pluginId}: ${error instanceof Error ? error.message : "unknown"}`);
				}
			}
			if (view.phase !== "ready")
				fail(`plugin_load_${String(view.phase)} session=${sessionId} plugin=${pluginId}`);
		}
	}

	async configureModels(options: PythonModelOptions, sessionId?: string): Promise<string[]> {
        if (!options.modelRef && !options.modelPatterns?.length) return [];
        let scope = await this.#resolveModels(options.modelPatterns ?? [options.modelRef ?? ""],options.provider ?? "");
        const warnings = [...scope.warnings];
        if (options.modelPatterns?.length) this.#scope = scope.choices;
        if (options.modelRef && options.modelPatterns?.length) {
            scope = await this.#resolveModels([options.modelRef],options.provider ?? "");
            warnings.push(...scope.warnings);
        }
        if (!scope.choices.length) fail("models_no_match");
        if (options.modelRef && scope.choices.length !== 1) fail("model_selector_ambiguous");
        const current = await this.#currentModel(sessionId);
        const selected = scope.choices.find(item => item.provider === current.provider && item.model === current.model) ?? scope.choices[0];
        if (!selected) fail("models_no_match");
        await this.#selectModel(selected,sessionId);
        return warnings;
    }

    async #resolveModels(patterns: readonly string[], provider:string): Promise<{
        choices:Array<{provider:string;model:string;thinking?:ThinkingLevel}>; warnings:string[];
    }> {
		const scope = await this.#send("POST", "/api/v1/models/scope", {
			patterns, provider,
		});
		if (!Array.isArray(scope.models)) fail("invalid_models");
		const choices = scope.models.map((entry:unknown) => {
			if (!isRecord(entry) || !isRecord(entry.model) || typeof entry.model.provider !== "string" || typeof entry.model.model !== "string")
				fail("invalid_models");
			return {provider:entry.model.provider, model:entry.model.model,
				...(typeof entry.thinking === "string" && ["off","minimal","low","medium","high","xhigh","max"].includes(entry.thinking)
					? {thinking:entry.thinking as ThinkingLevel} : {})};
		});
        return {choices, warnings:Array.isArray(scope.diagnostics) ? scope.diagnostics.filter((item:unknown):item is string => typeof item === "string") : []};
    }

	async cycleModel(sessionId: string): Promise<string> {
		if (!this.#scope.length) fail("model_cycle_requires_models_option");
		const current = this.#runOptions.model_selection ?? await this.#currentModel(sessionId);
		const index = this.#scope.findIndex(item => item.provider === current.provider && item.model === current.model);
		const selected = this.#scope[(index + 1) % this.#scope.length];
		if (!selected) fail("models_no_match");
		await this.#selectModel(selected,sessionId);
		return `${selected.provider}/${selected.model}`;
	}

	async #currentModel(sessionId?: string): Promise<Record<string, unknown>> {
		if (sessionId) {
			try { return await this.#send("GET", `/api/v1/session-models/${sessionId}`); }
			catch (error) { if (!(error instanceof HostRequestError && error.status === 404)) throw error; }
		}
		const catalog = await this.#send("GET", "/api/v1/models");
		if (!isRecord(catalog.current)) fail("invalid_models");
		return catalog.current;
	}

	async #selectModel(selected: {provider:string;model:string;thinking?:ThinkingLevel}, sessionId?:string): Promise<void> {
		if (sessionId) await this.#send("PUT", `/api/v1/session-models/${sessionId}`, {
			session_id:sessionId, provider:selected.provider, model:selected.model,
		});
		this.#runOptions.model_selection = {provider:selected.provider, model:selected.model};
		if (!this.#thinkingOverride) this.#runOptions.thinking = selected.thinking;
	}

	setThinking(level: ThinkingLevel): void {
		this.#thinkingOverride = true;
		this.#runOptions.thinking = level;
	}

	async resources(sessionId: string): Promise<Record<string, unknown>> {
		return this.#send("POST", `/api/v1/sessions/${sessionId}/resources`, {...this.#runOptions.resource_options});
	}

	async selectWorkspace(cwd: string, name = ""): Promise<string> {
		const body = await this.#send("POST", "/api/v1/workspaces/select", {host_path:cwd, name});
		if (typeof body.name !== "string" || !body.name) fail("invalid_workspace");
		return body.name;
	}

	async listSessions(workspace: string): Promise<SessionSummary[]> {
		const body = await this.#send("GET", "/api/v1/sessions");
		if (!Array.isArray(body.sessions)) fail("invalid_session");
		return body.sessions.flatMap((item: unknown) => {
			if (!isRecord(item) || typeof item.session_id !== "string" || typeof item.title !== "string" || typeof item.workspace !== "string")
				fail("invalid_session");
			return item.workspace === workspace
				? [{session_id:item.session_id, title:item.title, workspace:item.workspace, archived:item.archived === true}]
				: [];
		});
	}

	async recent(workspace: string): Promise<string | undefined> {
		return (await this.listSessions(workspace))
			.filter((item) => !item.archived)
			.at(-1)?.session_id;
	}

	async snapshot(sessionId: string): Promise<Record<string, unknown>> {
		return this.#send("GET", `/api/v1/sessions/${sessionId}/snapshot`);
	}

	async inspectRequest(sessionId: string, requestId: string): Promise<Polled> {
		return this.#untilDecision(sessionId, requestId);
	}

	async open(workspace: string, title = "命令"): Promise<OpenedSession> {
		if (!workspace) fail("workspace_required");
		const created = await this.#send("POST", "/api/v1/sessions", {title, workspace, session_id:hexId()});
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
		requestId = hexId(),
	): Promise<Polled> {
		await this.#requireWorkspace(sessionId, workspace);
		try {
			await this.#send(
				"POST",
				`/api/v1/sessions/${sessionId}/submissions`,
				{
					...this.#runOptions,
					request_id: requestId,
					text,
					images: images.map((image) => ({media_type:image.mimeType, data_base64:image.data})),
				},
				attachmentId,
			);
		} catch (error) {
			if (error instanceof HostRequestError && error.status < 500) throw error;
			return {
				receipt: {
					request_id: requestId,
					status: "unknown",
					error: "submission_unconfirmed",
				},
			};
		}
		try {
			return await this.#untilDecision(sessionId, requestId);
		} catch {
			return {
				receipt: {
					request_id: requestId,
					status: "unknown",
					error: "receipt_unconfirmed",
				},
			};
		}
	}

	async decideRequest(
		sessionId: string,
		attachmentId: string,
		requestId: string,
		approve: boolean,
		reviewedApproval: Record<string, unknown>,
		decisionId = "",
	): Promise<Record<string, unknown>> {
		const approval = reviewedApproval;
		if (!approval || approval.request_id !== requestId) fail("approval_not_found");
		const approvalId = approval.approval_id;
		const revision = approval.revision;
		const digest = approval.proposal_digest;
		if (typeof approvalId !== "string" || typeof revision !== "string" || typeof digest !== "string")
			fail("invalid_approval");
		if (["approved","consumed","denied"].includes(String(approval.state)))
			return (await this.#untilDecision(sessionId,requestId)).receipt;
		await this.#send(
			"POST",
			`/api/v1/sessions/${sessionId}/approvals`,
			{
				decision_id: decisionId || createHash("sha256").update(JSON.stringify([sessionId, approvalId, approve])).digest("hex").slice(0,32),
				approval_id: approvalId,
				expected_revision: revision,
				proposal_digest: digest,
				approve,
			},
			attachmentId,
		);
		return (await this.#untilDecision(sessionId, requestId)).receipt;
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
		decisionId = "",
	): Promise<Record<string, unknown>> {
		const state = await this.#send("GET", `/api/v1/sessions/${sessionId}/mcp`);
		const calls = state.calls;
		if (!Array.isArray(calls)) fail("invalid_mcp");
		const found = calls.find((item) => isRecord(item) && item.call_id === callId);
		if (!isRecord(found) || typeof found.server_id !== "string" || typeof found.digest !== "string")
			fail("mcp_call_not_found");
		if (found.phase !== "waiting_approval") return this.#untilMcp(sessionId, callId, found);
		const decided = await this.#send(
			"POST",
			`/api/v1/sessions/${sessionId}/mcp/${found.server_id}/calls/${callId}/decision`,
			{
				decision_id: decisionId || createHash("sha256").update(JSON.stringify([sessionId,found.server_id,callId,approve])).digest("hex").slice(0,32),
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

	async reviewedApproval(sessionId: string, requestId: string, approvalId?: string): Promise<Record<string, unknown>> {
		if (!approvalId) fail("approval_id_required");
		const snapshot = await this.#send("GET", `/api/v1/sessions/${sessionId}/snapshot`);
		if (!Array.isArray(snapshot.approvals)) fail("approval_not_found");
		const found = snapshot.approvals.find((item:unknown) => isRecord(item) && item.approval_id === approvalId && item.request_id === requestId);
		if (!isRecord(found)) fail("approval_not_found");
		return found;
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
			throw new HostRequestError(response.status, code);
		}
		return payload;
	}
}
