import { type Context, defineFacet, type Facet, type MutableReplicatedState } from "@amazme/chord";
import { withAbortSignal } from "@amazme/chord/context";
import type { ExecutionEnv } from "@amazme/durable/env";
import type { AgentOperationError } from "../../core/plugins/agent-controller.ts";
import { executeBashWithOperations } from "../../core/bash-executor.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { createLocalBashOperations } from "../../core/tools/bash.ts";
import { Terminal, type TerminalRunResult, type TerminalState } from "./terminal.ts";

/** How much output the buffer keeps; older output is dropped and the view says so. */
export const TERMINAL_MAX_BYTES = 64 * 1024;
/** The shortest gap between two publications while output arrives. */
export const TERMINAL_PUBLISH_MS = 200;

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
		error: null,
	});
	let running: AbortController | undefined;
	let finished: Promise<void> | undefined;
	/** Output received but not yet published; the state carries the tail the reader sees. */
	let pending = "";
	let truncated = false;
	let flushTimer: NodeJS.Timeout | undefined;
	let lastFlushAt = 0;
	let liveContext: Context | undefined;

	const appendTail = (draft: TerminalState, chunk: string): void => {
		const combined = draft.output + chunk;
		if (combined.length <= TERMINAL_MAX_BYTES) {
			draft.output = combined;
			return;
		}
		draft.output = combined.slice(combined.length - TERMINAL_MAX_BYTES);
		draft.truncated = true;
	};

	/** Move whatever arrived into the state, once. */
	const flush = (): void => {
		if (flushTimer !== undefined) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		const chunk = pending;
		pending = "";
		const context = liveContext;
		const wasTruncated = truncated;
		truncated = false;
		lastFlushAt = Date.now();
		if (context === undefined || (chunk.length === 0 && !wasTruncated)) return;
		state.change(context, (draft) => {
			appendTail(draft, chunk);
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
				pending = "";
				truncated = false;
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
					const onChunk = (chunk: string): void => { pending += chunk; scheduleFlush(); };
					const execute = async () => {
						if (!options.env) return executeBashWithOperations(resolved, options.cwd, createLocalBashOperations({ shellPath: options.settings.getShellPath() }), { signal: controller.signal, onChunk });
						const outcome = await options.env.exec(resolved, { onOutput: onChunk }, withAbortSignal(controller.signal, context));
						if (!outcome.ok) throw outcome.error;
						return { output: "", exitCode: outcome.value.exitCode, cancelled: controller.signal.aborted, truncated: false };
					};
					const result = await execute();
					flush();
					publish(context, (draft) => {
						draft.status = result.cancelled ? "cancelled" : "done";
						draft.exitCode = result.exitCode ?? null;
						// The executor's own tail is authoritative once it has settled.
						if (result.output.length > 0) appendTail(draft, result.output.slice(draft.output.length));
						draft.truncated = draft.truncated || result.truncated;
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
			},
		} satisfies Terminal,
	};
}

/** The terminal as a facet: one shell for the Session's working directory. */
export function createTerminalFacet(options: TerminalServiceOptions): Facet {
	return defineFacet({
		id: "@pi/terminal",
		setup(env) {
			const runtime = createTerminalService(options, (initial) => env.replicatedState(initial));
			env.provide(Terminal, runtime.service);
		},
	});
}
