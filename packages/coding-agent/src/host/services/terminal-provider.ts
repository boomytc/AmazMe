import { serviceFacet, type ServiceValue } from "@amazme/protocol/services";
import { replicatedState } from "@amazme/chord";
import { type Context, type Facet, type MutableReplicatedState } from "@amazme/chord";
import { withAbortSignal } from "@amazme/chord/context";
import type { ExecutionEnv } from "@amazme/durable/env";
import type { AgentOperationError } from "../../core/plugins/agent-controller.ts";
import { executeBashWithOperations } from "../../core/bash-executor.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { createLocalBashOperations } from "../../core/tools/bash.ts";
import { Terminal, type TerminalRunResult, type TerminalState } from "./terminal.ts";

/** UTF-8 bytes kept in each pending or published tail; older output is dropped visibly. */
export const TERMINAL_MAX_BYTES = 64 * 1024;
/** The shortest gap between two publications while output arrives. */
export const TERMINAL_PUBLISH_MS = 200;

/** Bound a chunk before encoding it, and never retain part of a UTF-8 character. */
function appendTail(tail: Pick<TerminalState, "output" | "truncated">, chunk: string): void {
	let start = Math.max(0, chunk.length - TERMINAL_MAX_BYTES);
	if (start > 0) {
		const character = chunk.charCodeAt(start);
		const previous = chunk.charCodeAt(start - 1);
		if (character >= 0xdc00 && character <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start += 1;
		tail.output = "";
		tail.truncated = true;
	}
	const combined = tail.output + chunk.slice(start);
	const bytes = Buffer.from(combined, "utf8");
	if (bytes.byteLength <= TERMINAL_MAX_BYTES) {
		tail.output = combined;
		return;
	}
	let offset = bytes.byteLength - TERMINAL_MAX_BYTES;
	while ((bytes[offset]! & 0xc0) === 0x80) offset += 1;
	tail.output = bytes.subarray(offset).toString("utf8");
	tail.truncated = true;
}

export interface TerminalServiceOptions {
	readonly env?: ExecutionEnv;
	readonly admission?: (context: Context) => Promise<AgentOperationError | undefined>;
	/** The Session's working directory; every command runs there. */
	readonly cwd: string;
	/** Shell path and command prefix come from the same settings the agent's bash tool reads. */
	readonly settings: SettingsManager;
}

/**
 * One shell per Session, over the same execution path the agent's bash tool uses: the local shell
 * operations, the settings' shell path and command prefix, and the executor that sanitizes binary
 * output and truncates it. Output streams into the replicated buffer (coalesced so a chatty command
 * does not publish per byte), and `stop()` aborts the same controller the executor watches, so a
 * stopped command settles as cancelled with what it printed.
 */
export function createTerminalService(
	options: TerminalServiceOptions,
	createState: (initial: TerminalState) => MutableReplicatedState<TerminalState>,
) {
	const state = createState({
		revision: 0,
		status: "idle",
		command: null,
		exitCode: null,
		output: "",
		truncated: false,
		error: null });
	let running: AbortController | undefined;
	let finished: Promise<void> | undefined;
	/** Output received but not yet published; the state carries the tail the reader sees. */
	let pending = { output: "", truncated: false };
	let flushTimer: NodeJS.Timeout | undefined;
	let lastFlushAt = 0;
	let liveContext: Context | undefined;

	/** Move whatever arrived into the state, once. */
	const flush = (): void => {
		if (flushTimer !== undefined) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		const tail = pending;
		pending = { output: "", truncated: false };
		const context = liveContext;
		lastFlushAt = Date.now();
		if (context === undefined || (tail.output.length === 0 && !tail.truncated)) return;
		state.change(context, (draft) => {
			// Pending truncation creates a gap after the old view; only the new tail is contiguous.
			if (tail.truncated) draft.output = "";
			appendTail(draft, tail.output);
			draft.truncated ||= tail.truncated;
			draft.revision += 1;
		});
	};

	const scheduleFlush = (): void => {
		const elapsed = Date.now() - lastFlushAt;
		if (elapsed >= TERMINAL_PUBLISH_MS) {
			flush();
			return;
		}
		if (flushTimer !== undefined) return;
		flushTimer = setTimeout(flush, TERMINAL_PUBLISH_MS - elapsed);
		flushTimer.unref?.();
	};

	const publish = (context: Context, update: (draft: TerminalState) => void): void => {
		state.change(context, (draft) => {
			draft.revision += 1;
			update(draft);
		});
	};

	return {
		service: {
			state,
			async run(command: string, context: Context): Promise<TerminalRunResult> {
				await options.settings.reload();
				const refusal = await options.admission?.(context);
				if (refusal) return { ok: false, problem: refusal.message };
				const trimmed = command.trim();
				if (trimmed.length === 0) return { ok: false, problem: "Type a command to run." };
				if (running !== undefined) return { ok: false, problem: "A command is already running." };
				const prefix = options.settings.getShellCommandPrefix();
				const resolved = prefix === undefined || prefix.length === 0 ? trimmed : `${prefix}\n${trimmed}`;
				const controller = new AbortController();
				running = controller;
				let finish!: () => void;
				finished = new Promise<void>(resolve => { finish = resolve; });
				pending = { output: "", truncated: false };
				liveContext = context;
				publish(context, (draft) => {
					draft.status = "running";
					draft.command = trimmed;
					draft.exitCode = null;
					draft.output = "";
					draft.truncated = false;
					draft.error = null;
				});
				try {
					const onChunk = (chunk: string): void => { appendTail(pending, chunk); scheduleFlush(); };
					const execute = async () => {
						if (!options.env) return executeBashWithOperations(resolved, options.cwd, createLocalBashOperations({ shellPath: options.settings.getShellPath() }), { artifactDirectory: null, signal: controller.signal, onChunk });
						const outcome = await options.env.exec(resolved, { onOutput: onChunk }, withAbortSignal(controller.signal, context));
						if (!outcome.ok) throw outcome.error;
						return { output: "", exitCode: outcome.value.exitCode, cancelled: controller.signal.aborted, truncated: false };
					};
					const result = await execute();
					flush();
					publish(context, (draft) => {
						draft.status = result.cancelled ? "cancelled" : "done";
						draft.exitCode = result.exitCode ?? null;
						// The executor's final decoder flush already reached onChunk. Its result uses a
						// different tail limit and must not be merged into this independently bounded view.
					});
					return { ok: true };
				} catch (error) {
					flush();
					if (controller.signal.aborted) {
						publish(context, draft => { draft.status = "cancelled"; draft.exitCode = null; draft.error = null; });
						return { ok: true };
					}
					const problem = error instanceof Error ? error.message : String(error);
					publish(context, (draft) => {
						draft.status = "done";
						draft.error = problem;
					});
					return { ok: false, problem };
				} finally {
					finish(); finished = undefined;
					flush();
					running = undefined;
					liveContext = undefined;
				}
			},
			async stop(_context: Context): Promise<void> {
				running?.abort();
				await finished;
			} } satisfies Terminal };
}

/** The terminal as a facet: one shell for the Session's working directory. */
export function createTerminalFacet(options: TerminalServiceOptions): Facet {
	return serviceFacet("@pi/terminal", Terminal, [], async (services) => {
		const runtime = createTerminalService(options, (initial) => replicatedState(initial));
		const implementation: ServiceValue<typeof Terminal> = runtime.service;

		return { value: implementation };
	});
}
