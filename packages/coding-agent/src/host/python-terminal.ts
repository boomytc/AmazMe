import { randomBytes } from "node:crypto";
import type { Context } from "@amazme/chord";
import { err, ExecutionError, type ExecutionEnv, type ShellExecOptions, type ShellExecResult } from "@amazme/durable/env";
import { NodeExecutionEnv } from "@amazme/durable/env/node";

interface PythonIdentity {
	readonly build_id: string;
	readonly host_epoch: number;
}

interface TerminalBody {
	readonly phase: string;
	readonly exit_code: number | null;
	readonly output: string;
	readonly code?: string;
}

function target(): { base: string; token: string; session: string } | undefined {
	const base = process.env.AMAZME_PYTHON_URL;
	const token = process.env.AMAZME_PYTHON_TOKEN;
	const session = process.env.AMAZME_PYTHON_SESSION;
	if (!base || !token || !session) return undefined;
	return { base: base.replace(/\/$/, ""), token, session };
}

async function identity(base: string, token: string): Promise<PythonIdentity> {
	const response = await fetch(`${base}/api/v1/bootstrap`, {
		headers: { authorization: `Bearer ${token}` },
	});
	if (!response.ok) throw new Error(`python_bootstrap:${response.status}`);
	return await response.json() as PythonIdentity;
}

async function pythonError(response: Response): Promise<Error> {
	const body = await response.json().catch(() => undefined) as { code?: string } | undefined;
	return new Error(body?.code ?? `python_terminal:${response.status}`);
}

/** Run one command through the Python terminal API. The process does not open a host shell. */
export async function runPythonTerminal(command: string, onOutput?: (text: string) => void): Promise<TerminalBody> {
	const where = target();
	if (where === undefined) throw new Error("python_terminal_unconfigured");
	const who = await identity(where.base, where.token);
	const headers = {
		authorization: `Bearer ${where.token}`,
		"content-type": "application/json",
		"x-amazme-build": who.build_id,
		"x-amazme-epoch": String(who.host_epoch),
	};
	const attached = await fetch(`${where.base}/api/v1/sessions/${where.session}/attachments`, {
		method: "POST",
		headers,
	});
	if (!attached.ok) throw await pythonError(attached);
	const attachment = await attached.json() as { attachment_id: string };
	const terminalId = randomBytes(16).toString("hex");
	const opened = await fetch(`${where.base}/api/v1/sessions/${where.session}/terminals`, {
		method: "POST",
		headers: { ...headers, "x-amazme-attachment": attachment.attachment_id },
		body: JSON.stringify({ terminal_id: terminalId, command, cols: 80, rows: 24 }),
	});
	if (!opened.ok) throw await pythonError(opened);
	let view = await opened.json() as TerminalBody;
	const deadline = Date.now() + 20_000;
	while (view.phase === "running" && view.exit_code === null && Date.now() < deadline) {
		const read = await fetch(`${where.base}/api/v1/sessions/${where.session}/terminals/${terminalId}/read`, {
			method: "POST",
			headers: { ...headers, "x-amazme-attachment": attachment.attachment_id },
		});
		if (!read.ok) throw await pythonError(read);
		view = await read.json() as TerminalBody;
		if (view.output) onOutput?.(view.output);
	}
	return view;
}

/** Terminal execution for the test host. File reads stay local; commands go to Python. */
export class PythonTerminalEnv extends NodeExecutionEnv implements ExecutionEnv {
	override async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<{ ok: true; value: ShellExecResult } | { ok: false; error: ExecutionError }> {
		if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const text = typeof command === "string" ? command : command.join(" ");
		try {
			const view = await runPythonTerminal(text, (chunk) => options?.onOutput?.(chunk, context, { stream: "stdout" }));
			if (view.phase === "exited" && view.exit_code === 0) return { ok: true, value: { exitCode: 0 } };
			return err(new ExecutionError("shell_unavailable", view.phase === "unknown" ? "pty_unknown" : `pty_exit:${view.exit_code ?? "none"}`));
		} catch (error) {
			return err(new ExecutionError("shell_unavailable", error instanceof Error ? error.message : String(error)));
		}
	}
}
