import type { AgentEventStream } from "@amazme/durable";
import type { AssistantMessage, ImageContent } from "@amazme/ai";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { DurableJsonEvents } from "./json-events.ts";
import { openDurable, type OpenDurableOptions } from "./runtime.ts";

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

export async function runDurablePrint(options: DurablePrintOptions): Promise<number> {
	const durable = await openDurable(options);
	let exitCode = 0;
	const handlers: SignalHandler[] = [];
	let closing: Promise<void> | undefined;

	const close = (): Promise<void> => {
		closing ??= durable.close();
		return closing;
	};

	for (const signal of (process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"]) as NodeJS.Signals[]) {
		const handler = () => {
			killTrackedDetachedChildren();
			void close().finally(() => process.exit(signal === "SIGHUP" ? 129 : 143));
		};
		process.on(signal, handler);
		handlers.push({ signal, handler });
	}

	let answer: AssistantMessage | undefined;
	let stream: AgentEventStream | undefined;
	try {
		if (options.mode === "json") {
			const session = durable.view.current().session;
			writeRawStdout(`${JSON.stringify({ type: "session", version: 3, id: session.id, timestamp: new Date().toISOString(), cwd: session.cwd, storage: "durable" })}\n`);
			stream = await durable.watchAgentEvents();
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
			const result = await durable.controller.submitAndWait(text, "steer", images);
			if (!result.accepted) throw new Error("Input was not accepted");
			if (result.settled?.status === "unanswered") {
				const detail = result.settled.detail === undefined ? "" : ` ${JSON.stringify(result.settled.detail)}`;
				console.error(`No answer: ${result.settled.reason}${detail}`);
				exitCode = 1;
				return false;
			}
			answer = result.answer;
			return true;
		};

		if (options.initialMessage !== undefined) {
			if (!(await submit(options.initialMessage, options.initialImages))) return exitCode;
		}
		for (const message of options.messages ?? []) {
			if (!(await submit(message))) return exitCode;
		}

		if (answer === undefined) {
			console.error("No assistant response was committed");
			exitCode = 1;
		} else if (answer.stopReason === "error" || answer.stopReason === "aborted") {
			console.error(answer.errorMessage || `Request ${answer.stopReason}`);
			exitCode = 1;
		} else if (options.mode !== "json") {
			for (const content of answer.content) {
				if (content.type === "text") writeRawStdout(`${content.text}\n`);
			}
			if (answer.stopReason === "length") {
				console.error("Response was truncated: the model reached its output token limit.");
				exitCode = 1;
			}
		} else if (answer.stopReason === "length") {
			console.error("Response was truncated: the model reached its output token limit.");
			exitCode = 1;
		}
		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const { signal, handler } of handlers) process.off(signal, handler);
		try {
			if (stream !== undefined) {
				await new Promise<void>((resolve) => setImmediate(resolve));
				await stream.stop();
			}
		} finally {
			await close();
			await flushRawStdout();
		}
	}
}
