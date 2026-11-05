/**
 * Runs QuickJS on the helper's calling thread. Synchronous scripts block timers and abort
 * callbacks, so an interrupt budget bounds computation until control returns to the event loop.
 * Python owns the helper process and enforces its outer cancellation and timeout lifecycle.
 */
import type { CodemodeSandboxBaseOptions } from "../types.ts";
import type { CodemodeWasmModule } from "../wasm.ts";
import { CodemodeSandboxBase, errorMessage, type VmLauncher } from "./execution.ts";
import { startVm } from "./vm.ts";

export const DEFAULT_INTERRUPT_BUDGET = 100_000;

/** Allows recursion about 1,000 calls deep and trips well before a 1 MB host stack overflows. */
export const INLINE_MAX_STACK_SIZE = 256 * 1024;

export interface InlineCodemodeSandboxOptions extends CodemodeSandboxBaseOptions {
	/**
	 * Compiled `quickjs-wasi/quickjs.wasm`, provided by `loadQuickJSWasm()`.
	 */
	wasm: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	/**
	 * Interrupt polls an execution may use before it fails with `kind: "timeout"`. The only limit on
	 * a script that computes without awaiting a tool. Default: {@link DEFAULT_INTERRUPT_BUDGET}.
	 */
	interruptBudget?: number;
}

export function inlineLauncher(
	wasm: CodemodeWasmModule | Promise<CodemodeWasmModule>,
	interruptBudget: number = DEFAULT_INTERRUPT_BUDGET,
): VmLauncher {
	return async (data, events) => {
		let module: CodemodeWasmModule;
		try {
			module = await wasm;
		} catch (error) {
			throw new Error(`Failed to load QuickJS: ${errorMessage(error)}`);
		}
		let stopped = false;
		let settled = false;
		let polls = 0;
		let exhausted = false;
		const session = await startVm({
			data,
			wasm: module,
			maxStackSize: INLINE_MAX_STACK_SIZE,
			interruptBudget,
			shouldInterrupt: () => {
				if (stopped || settled || exhausted) return true;
				if (++polls <= interruptBudget) return false;
				exhausted = true;
				return true;
			},
			post: (message) => {
				const terminal = message.type === "done" || message.type === "crash";
				// Only the first terminal message counts: a crash caused by interrupting a settled VM is noise.
				if (terminal && settled) return;
				if (terminal) settled = true;
				queueMicrotask(() => {
					if (stopped) return;
					// The interrupt surfaces as a crash or a failed done; report what caused it instead.
					if (exhausted && (message.type === "done" || message.type === "crash")) {
						events.failure({
							kind: "timeout",
							message: `Execution exceeded its interrupt budget of ${interruptBudget}`,
						});
						return;
					}
					events.message(message);
				});
			},
		});
		return {
			post: (message) => {
				if (!stopped) session.deliver(message);
			},
			stop: async () => {
				if (stopped) return;
				stopped = true;
				session.dispose();
			},
		};
	};
}

/**
 * Runs each execution's QuickJS VM on the calling thread. Works in any runtime with WebAssembly
 * and microtasks; needs no worker threads, files, or Node built-ins. A script that computes
 * blocks the caller's thread until it awaits a tool or uses up its interrupt budget. Python owns
 * a separate helper process to keep the Host responsive.
 */
export class InlineCodemodeSandbox extends CodemodeSandboxBase {
	constructor(options: InlineCodemodeSandboxOptions) {
		super(options, inlineLauncher(options.wasm, options.interruptBudget));
	}
}
