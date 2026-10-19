import type { AgentMessage } from "@amazme/agent";
import type { AgentEvent, AgentEventStream } from "@amazme/durable";
import type { ExtensionRunner } from "../core/extensions/runner.ts";

/**
 * Bridge the Durable agent event stream to the extension runtime.
 *
 * The Durable path does not load the legacy extension runner by default (`loadCodingResources` disables
 * extensions). When a caller supplies a runner, this bridge gives its handlers the same session-level
 * lifecycle the coding agent emits, including the one `agent_settled` the Durable commit translation decides.
 * The settlement is read from the stream, so the two surfaces cannot disagree about whether queued work or
 * a retry will continue the run.
 */
export function bridgeExtensionEvents(stream: AgentEventStream, runner: ExtensionRunner): void {
	let messages: AgentMessage[] = [];
	stream.start(async (events) => {
		for (const event of events) {
			await forward(event, runner, messages, (next) => {
				messages = next;
			});
		}
	});
}

async function forward(
	event: AgentEvent,
	runner: ExtensionRunner,
	runMessages: AgentMessage[],
	setMessages: (messages: AgentMessage[]) => void,
): Promise<void> {
	if (event.type === "run_start") {
		setMessages([]);
		await runner.emit({ type: "agent_start" });
		return;
	}
	if (event.type === "message_end") {
		const message = event.entry.model?.[0];
		if (message !== undefined) setMessages([...runMessages, message]);
		return;
	}
	if (event.type === "run_end") {
		await runner.emit({ type: "agent_end", messages: runMessages });
		setMessages([]);
		return;
	}
	if (event.type === "agent_settled") {
		await runner.emit({ type: "agent_settled", aborted: event.aborted });
	}
}
