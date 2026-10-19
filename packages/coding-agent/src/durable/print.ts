import type { AgentEventStream } from "@amazme/durable";
import type { AssistantMessage, ImageContent } from "@amazme/ai";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { DurableJsonEvents } from "./json-events.ts";
import { openDurable, type OpenDurableOptions, type OpenDurableResult } from "./runtime.ts";

/**
 * Headless print mode on the Durable Harness.
 *
 * It owns its submission and waits for that receipt instead of global idle, and it reads the
 * answer from the committed transcript, so a process that exits after `wait()` cannot lose the
 * answer it already printed.
 */
export interface DurablePrintOptions extends OpenDurableOptions {
	readonly mode?: "text" | "json";
	readonly initialMessage?: string;
	readonly initialImages?: readonly ImageContent[];
	readonly messages?: readonly string[];
}

interface SignalHandler {
	readonly signal: NodeJS.Signals;
	readonly handler: () => void;
}

/** The status a signal-driven exit reports: 128 + the signal number. */
const SIGNAL_EXIT_CODES: Readonly<Record<"SIGINT" | "SIGTERM" | "SIGHUP", number>> = {
	SIGINT: 130,
	SIGTERM: 143,
	SIGHUP: 129,
};

export async function runDurablePrint(options: DurablePrintOptions): Promise<number> {
	let durable: OpenDurableResult | undefined;
	const exitCode = 0;
	const handlers: SignalHandler[] = [];
	let stream: AgentEventStream | undefined;
	let cleanup: Promise<void> | undefined;
	let interrupted: NodeJS.Signals | undefined;

	/**
	 * The one shutdown order: stop child processes, let committed batches finish, close Durable, drain raw stdout.
	 * The normal finally and a signal share it, and the order never differs between them.
	 */
	const shutdown = (): Promise<void> => {
		cleanup ??= (async () => {
			killTrackedDetachedChildren();
			try {
				if (stream !== undefined) {
					await new Promise<void>((resolve) => setImmediate(resolve));
					await stream.stop();
				}
			} finally {
				try {
					await durable?.close();
				} finally {
					// A closed reader ends the process through writeRawStdout's own EPIPE path.
					await flushRawStdout().catch(() => undefined);
				}
			}
		})();
		return cleanup;
	};

	const exitFor = (signal: NodeJS.Signals): void => {
		const code = SIGNAL_EXIT_CODES[signal as keyof typeof SIGNAL_EXIT_CODES] ?? 1;
		// A repeat signal leaves at once. The tail is explicitly not guaranteed at that point.
		if (interrupted !== undefined) process.exit(code);
		interrupted = signal;
		void shutdown().finally(() => process.exit(code));
	};

	const signals = (process.platform === "win32" ? ["SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"]) as NodeJS.Signals[];
	for (const signal of signals) {
		const handler = () => exitFor(signal);
		process.on(signal, handler);
		handlers.push({ signal, handler });
	}

	let answer: AssistantMessage | undefined;
	let code = exitCode;
	try {
		const opened = await openDurable(options);
		durable = opened;
		if (options.mode === "json") {
			const session = opened.view.current().session;
			writeRawStdout(`${JSON.stringify({ type: "session", version: 3, id: session.id, timestamp: new Date().toISOString(), cwd: session.cwd, storage: "durable" })}\n`);
			stream = await opened.watchAgentEvents();
			const translator = new DurableJsonEvents();
			stream.start(async (events) => {
				for (const event of events) {
					for (const translated of translator.translate(event)) {
						writeRawStdout(`${JSON.stringify(translated)}\n`);
					}
				}
			});
		}
		const submit = async (text: string, images?: readonly ImageContent[]): Promise<boolean> => {
			const result = await opened.controller.submitAndWait(text, "steer", images);
			if (!result.accepted) throw new Error("Input was not accepted");
			if (result.settled?.status === "unanswered") {
				const detail = result.settled.detail === undefined ? "" : ` ${JSON.stringify(result.settled.detail)}`;
				console.error(`No answer: ${result.settled.reason}${detail}`);
				code = 1;
				return false;
			}
			answer = result.answer;
			return true;
		};

		if (options.initialMessage !== undefined) {
			if (!(await submit(options.initialMessage, options.initialImages))) return code;
		}
		for (const message of options.messages ?? []) {
			if (!(await submit(message))) return code;
		}

		if (answer === undefined) {
			console.error("No assistant response was committed");
			code = 1;
		} else if (answer.stopReason === "error" || answer.stopReason === "aborted") {
			console.error(answer.errorMessage || `Request ${answer.stopReason}`);
			code = 1;
		} else if (options.mode !== "json") {
			for (const content of answer.content) {
				if (content.type === "text") writeRawStdout(`${content.text}\n`);
			}
			if (answer.stopReason === "length") {
				console.error("Response was truncated: the model reached its output token limit.");
				code = 1;
			}
		} else if (answer.stopReason === "length") {
			console.error("Response was truncated: the model reached its output token limit.");
			code = 1;
		}
		return code;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		code = 1;
		return code;
	} finally {
		// Listeners stay installed through the drain: a signal during shutdown still reports its status.
		await shutdown();
		for (const { signal, handler } of handlers) process.off(signal, handler);
	}
}
