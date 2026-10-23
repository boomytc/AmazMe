/**
 * Print, JSON, and RPC for one explicit Python host, session, and workspace.
 * Finishing releases the binding and does not cancel accepted work.
 */

import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { writeRawStdout } from "./core/output-guard.ts";
import { connectPythonHost } from "./python-session-tui.ts";

export interface PythonHeadlessOptions {
	readonly mode: "text" | "json" | "rpc";
	readonly workspace: string;
	readonly cwd: string;
	readonly url?: string;
	readonly token?: string;
	readonly prompt: string;
}

const TERMINAL = new Set(["succeeded", "cancelled", "interrupted", "failed", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string): never {
	throw new Error(code);
}

class HostClient {
	readonly #url: string;
	readonly #token: string;
	#buildId = "";
	#hostEpoch = 0;

	constructor(url: string, token: string) {
		this.#url = url.replace(/\/$/, "");
		this.#token = token;
	}

	async bootstrap(): Promise<void> {
		const body = await this.#send("GET", "/api/v1/bootstrap");
		if (typeof body.build_id !== "string" || typeof body.host_epoch !== "number") fail("invalid_bootstrap");
		this.#buildId = body.build_id;
		this.#hostEpoch = body.host_epoch;
	}

	async open(workspace: string): Promise<{ sessionId: string; attachmentId: string }> {
		if (!workspace) fail("workspace_required");
		const created = await this.#send("POST", "/api/v1/sessions", { title: "命令", workspace });
		if (typeof created.session_id !== "string" || created.workspace !== workspace) fail("invalid_session");
		const attached = await this.#send("POST", `/api/v1/sessions/${created.session_id}/attachments`);
		if (typeof attached.attachment_id !== "string") fail("invalid_attachment");
		return { sessionId: created.session_id, attachmentId: attached.attachment_id };
	}

	async submit(sessionId: string, workspace: string, attachmentId: string, text: string): Promise<Record<string, unknown>> {
		const current = await this.#send("GET", "/api/v1/sessions");
		const sessions = current.sessions;
		if (!Array.isArray(sessions)) fail("invalid_session");
		const found = sessions.find((item) => isRecord(item) && item.session_id === sessionId);
		if (!isRecord(found)) fail("session_not_found");
		if (found.workspace !== workspace) fail("workspace_mismatch");
		const requestId = randomBytes(8).toString("hex");
		await this.#send("POST", `/api/v1/sessions/${sessionId}/submissions`, { request_id: requestId, text }, attachmentId);
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const receipt = await this.#send("GET", `/api/v1/sessions/${sessionId}/requests/${requestId}`);
			if (typeof receipt.status === "string" && TERMINAL.has(receipt.status)) return receipt;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		fail("request_pending");
	}

	async release(sessionId: string, attachmentId: string): Promise<void> {
		await this.#send("DELETE", `/api/v1/sessions/${sessionId}/attachments/${attachmentId}`, undefined, attachmentId);
	}

	async rpc(call: unknown): Promise<unknown> {
		return this.#sendRaw("POST", "/api/v1/rpc", call);
	}

	async #send(method: string, path: string, jsonBody?: Record<string, unknown>, attachmentId = ""): Promise<Record<string, unknown>> {
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

async function runPrompt(client: HostClient, workspace: string, prompt: string, jsonMode: boolean): Promise<number> {
	if (!prompt) {
		process.stderr.write("missing_prompt\n");
		return 1;
	}
	const opened = await client.open(workspace);
	try {
		const receipt = await client.submit(opened.sessionId, workspace, opened.attachmentId, prompt);
		const status = typeof receipt.status === "string" ? receipt.status : "failed";
		const answer = typeof receipt.answer === "string" ? receipt.answer : "";
		if (jsonMode) {
			await writeRawStdout(`${JSON.stringify({
				workspace,
				session_id: opened.sessionId,
				request_id: receipt.request_id,
				status,
				answer,
			})}\n`);
		} else if (status === "succeeded") {
			await writeRawStdout(`${answer}\n`);
		} else {
			process.stderr.write(`${status}\n`);
		}
		return status === "succeeded" ? 0 : 1;
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
	try {
		const host = await connectPythonHost({ cwd: options.cwd, url: options.url, token: options.token });
		const client = new HostClient(host.url, host.token);
		await client.bootstrap();
		if (options.mode === "rpc") return await runRpc(client);
		return await runPrompt(client, options.workspace, options.prompt, options.mode === "json");
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "python_headless_failed"}\n`);
		return 1;
	}
}
