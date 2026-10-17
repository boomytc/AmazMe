import { getSupportedThinkingLevels, type Model, type Usage } from "@amazme/ai";
import type { AgentEvent } from "@amazme/durable";
import { flushRawStdout, takeOverStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../../core/output-guard.ts";
import { createSyntheticSourceInfo } from "../../core/source-info.ts";
import { writeDurableExport } from "../../durable/export.ts";
import { DurableJsonEvents } from "../../durable/json-events.ts";
import { agentOf, openDurable, type OpenDurableOptions, type OpenDurableResult } from "../../durable/runtime.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

/**
 * Durable RPC: the core prompt/state/model protocol over one Durable session.
 *
 * This is intentionally narrower than the JSONL RPC mode. Commands that depend on the terminal
 * session tree, SDK extension UI, JSONL export or shell bookkeeping return an explicit unsupported
 * error instead of a fabricated result. The prompt path admits input and reports its disposition;
 * model and tool output continue as Durable agent events on stdout.
 */
export interface DurableRpcOptions extends OpenDurableOptions {}

type SuccessCommand = RpcCommand["type"];

function success(id: string | undefined, command: SuccessCommand, data?: object | null): RpcResponse {
	return (data === undefined
		? { id, type: "response", command, success: true }
		: { id, type: "response", command, success: true, data }) as RpcResponse;
}

function error(id: string | undefined, command: string, message: string): RpcResponse {
	return { id, type: "response", command, success: false, error: message } as RpcResponse;
}

function usageTotals(usage: { models?: Record<string, Usage>; tools?: Record<string, Usage> } | undefined): {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
} {
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	let cost = 0;
	for (const entry of [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})]) {
		tokens.input += entry.input;
		tokens.output += entry.output;
		tokens.cacheRead += entry.cacheRead;
		tokens.cacheWrite += entry.cacheWrite;
		tokens.total += entry.totalTokens;
		cost += entry.cost.total;
	}
	return { tokens, cost };
}

/** Build the command handler over an opened Durable session. Exported for direct protocol tests. */
export function createDurableRpcHandler(durable: OpenDurableResult): (command: RpcCommand) => Promise<RpcResponse> {
	const view = () => durable.view.current();
	const agent = () => agentOf(view().conversation);
	const messages = () => view().conversation.entries.flatMap((entry) => entry.model ?? []);
	const modelOf = (ref: { provider: string; modelId: string } | undefined): Model<string> | undefined =>
		ref === undefined ? undefined : durable.availableModels().find((model) => model.provider === ref.provider && model.id === ref.modelId);

	const state = (): RpcSessionState => {
		const current = view();
		const currentAgent = agent();
		const model = modelOf(currentAgent.model);
		const inbox = current.conversation.docs["amazme.inbox"] as { items?: readonly unknown[] } | undefined;
		return {
			...(model === undefined ? {} : { model }),
			thinkingLevel: currentAgent.thinkingLevel ?? "off",
			isStreaming: current.lane.run !== "idle" && current.lane.run !== "compacting",
			isCompacting: current.lane.run === "compacting",
			steeringMode: durable.settings.getSteeringMode(),
			followUpMode: durable.settings.getFollowUpMode(),
			sessionFile: undefined,
			sessionId: current.session.id,
			...(current.session.name === undefined ? {} : { sessionName: current.session.name }),
			autoCompactionEnabled: durable.settings.getCompactionSettings().enabled,
			messageCount: messages().length,
			pendingMessageCount: inbox?.items?.length ?? 0,
		};
	};

	const stats = (): {
		sessionFile: string | undefined;
		sessionId: string;
		userMessages: number;
		assistantMessages: number;
		toolCalls: number;
		toolResults: number;
		totalMessages: number;
		tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		cost: number;
	} => {
		const all = messages();
		const usage = (view().conversation.docs["amazme.usage"] ?? undefined) as
			| { models?: Record<string, Usage>; tools?: Record<string, Usage> }
			| undefined;
		const totals = usageTotals(usage);
		return {
			sessionFile: undefined,
			sessionId: view().session.id,
			userMessages: all.filter((message) => message.role === "user").length,
			assistantMessages: all.filter((message) => message.role === "assistant").length,
			toolCalls: all.reduce(
				(count, message) => count + (message.role === "assistant" ? message.content.filter((content) => content.type === "toolCall").length : 0),
				0,
			),
			toolResults: all.filter((message) => message.role === "toolResult").length,
			totalMessages: all.length,
			tokens: totals.tokens,
			cost: totals.cost,
		};
	};

	const lastAssistantText = (): string | undefined => {
		const all = messages();
		for (let index = all.length - 1; index >= 0; index--) {
			const message = all[index];
			if (message?.role !== "assistant") continue;
			const text = message.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("");
			return text.length === 0 ? undefined : text;
		}
		return undefined;
	};

	const commands = (): RpcSlashCommand[] =>
		(view().commands ?? []).map((command) => ({
			name: command.name,
			...(command.description === undefined ? {} : { description: command.description }),
			source: command.name.startsWith("skill:") ? "skill" : "prompt",
			sourceInfo: createSyntheticSourceInfo(`<durable:${command.name}>`, { source: "durable" }),
		}));

	const unsupported = (id: string | undefined, command: RpcCommand["type"], detail?: string): RpcResponse =>
		error(id, command, `The Durable RPC adapter does not support ${command} yet${detail === undefined ? "" : `: ${detail}`}`);

	return async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;
		switch (command.type) {
			case "prompt": {
				const admission = await durable.controller.submitForRpc(
					command.message,
					command.streamingBehavior ?? "steer",
					command.images,
				);
				return success(id, "prompt", { disposition: admission.disposition });
			}
			case "steer": {
				const admission = await durable.controller.submitForRpc(command.message, "steer", command.images);
				return success(id, "steer", { disposition: admission.disposition === "handled" ? "handled" : "queued" });
			}
			case "follow_up": {
				const admission = await durable.controller.submitForRpc(command.message, "followUp", command.images);
				return success(id, "follow_up", { disposition: admission.disposition === "handled" ? "handled" : "queued" });
			}
			case "abort":
				await durable.controller.abort();
				return success(id, "abort");
			case "get_state":
				return success(id, "get_state", state());
			case "set_model": {
				const model = durable.availableModels().find((candidate) => candidate.provider === command.provider && candidate.id === command.modelId);
				if (model === undefined) return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				await durable.controller.setModelNow({ provider: model.provider, modelId: model.id });
				return success(id, "set_model", model);
			}
			case "cycle_model":
				await durable.controller.cycleModel();
				{
					const next = modelOf(agent().model);
					if (next === undefined) return success(id, "cycle_model", null);
					return success(id, "cycle_model", { model: next, thinkingLevel: agent().thinkingLevel ?? "off", isScoped: false });
				}
			case "get_available_models":
				return success(id, "get_available_models", { models: durable.availableModels() });
			case "set_thinking_level":
				await durable.controller.setThinkingLevelNow(command.level);
				return success(id, "set_thinking_level");
			case "cycle_thinking_level": {
				const model = modelOf(agent().model);
				if (model === undefined) return success(id, "cycle_thinking_level", null);
				const levels = getSupportedThinkingLevels(model);
				const current = agent().thinkingLevel ?? "off";
				const next = levels[(levels.indexOf(current) + 1) % levels.length];
				if (next === undefined) return success(id, "cycle_thinking_level", null);
				await durable.controller.setThinkingLevelNow(next);
				return success(id, "cycle_thinking_level", { level: next });
			}
			case "get_available_thinking_levels": {
				const model = modelOf(agent().model);
				return success(id, "get_available_thinking_levels", { levels: model === undefined ? [] : getSupportedThinkingLevels(model) });
			}
			case "set_steering_mode":
				durable.settings.setSteeringMode(command.mode);
				await durable.settings.flush();
				return success(id, "set_steering_mode");
			case "set_follow_up_mode":
				durable.settings.setFollowUpMode(command.mode);
				await durable.settings.flush();
				return success(id, "set_follow_up_mode");
			case "set_auto_compaction":
				durable.settings.setCompactionEnabled(command.enabled);
				await durable.settings.flush();
				return success(id, "set_auto_compaction");
			case "set_auto_retry":
				durable.settings.setRetryEnabled(command.enabled);
				await durable.settings.flush();
				return success(id, "set_auto_retry");
			case "export_html": {
				const current = view().conversation;
				const stored = current.docs["amazme.agent"] as { cwd?: unknown } | undefined;
				const exported = await writeDurableExport(current.entries, {
					id: view().session.id,
					cwd: typeof stored?.cwd === "string" ? stored.cwd : process.cwd(),
					format: "html",
					...(command.outputPath === undefined ? {} : { output: command.outputPath }),
				});
				return success(id, "export_html", { path: exported.path });
			}
			case "get_session_stats":
				return success(id, "get_session_stats", stats());
			case "get_messages":
				return success(id, "get_messages", { messages: messages() });
			case "get_last_assistant_text": {
				const text = lastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}
			case "set_session_name":
				await durable.controller.setSessionName(command.name);
				return success(id, "set_session_name");
			case "get_commands":
				return success(id, "get_commands", { commands: commands() });
			case "clear_queue":
				return success(id, "clear_queue", await durable.controller.clearQueue());
			case "fork":
				await durable.controller.forkAt(command.entryId);
				return success(id, "fork", { text: "", cancelled: false });
			case "clone":
				await durable.controller.forkAt();
				return success(id, "clone", { cancelled: false });
			case "new_session":
			case "compact":
			case "abort_retry":
			case "bash":
			case "abort_bash":
			case "switch_session":
			case "get_fork_messages":
			case "get_entries":
			case "get_tree":
				return unsupported(id, command.type);
			default: {
				const unknown = command as { type: string };
				return error(id, unknown.type, `Unknown command: ${unknown.type}`);
			}
		}
	};
}

export async function runDurableRpc(options: DurableRpcOptions = {}): Promise<never> {
	const durable = await openDurable(options);
	takeOverStdout();
	const handleCommand = createDurableRpcHandler(durable);
	const stream = await durable.watchAgentEvents();
	const translator = new DurableJsonEvents();
	stream.start(async (events: readonly AgentEvent[]) => {
		for (const event of events) {
			for (const translated of translator.translate(event)) {
				writeRawStdout(serializeJsonLine(translated));
				await waitForRawStdoutBackpressure();
			}
		}
	});

	const output = (value: RpcResponse | object): void => {
		writeRawStdout(serializeJsonLine(value));
	};

	let shuttingDown = false;
	let detachInput = (): void => {};
	const shutdown = async (exitCode = 0): Promise<never> => {
		if (shuttingDown) process.exit(exitCode);
		shuttingDown = true;
		detachInput();
		process.stdin.pause();
		await stream.stop().catch(() => {});
		await durable.close().catch(() => {});
		await flushRawStdout().catch(() => {});
		process.exit(exitCode);
	};

	const handleLine = async (line: string): Promise<void> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(error(undefined, "parse", `Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
			await waitForRawStdoutBackpressure();
			return;
		}
		if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "extension_ui_response") {
			const response = parsed as RpcExtensionUIResponse;
			void response;
			return;
		}
		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			output(response);
			await waitForRawStdoutBackpressure();
		} catch (commandError: unknown) {
			output(error(command.id, command.type, commandError instanceof Error ? commandError.message : String(commandError)));
			await waitForRawStdoutBackpressure();
		}
	};

	let chain = Promise.resolve();
	const onLine = (line: string): void => {
		chain = chain.then(() => handleLine(line)).catch((lineError: unknown) => {
			output(error(undefined, "internal", lineError instanceof Error ? lineError.message : String(lineError)));
		});
	};

	const signals: NodeJS.Signals[] = ["SIGTERM"];
	if (process.platform !== "win32") signals.push("SIGHUP");
	const handlers = signals.map((signal) => {
		const handler = () => {
			killTrackedDetachedChildren();
			void shutdown(signal === "SIGHUP" ? 129 : 143).catch(() => process.exit(signal === "SIGHUP" ? 129 : 143));
		};
		process.on(signal, handler);
		return { signal, handler };
	});
	process.stdin.on("end", () => void shutdown().catch(() => process.exit(0)));
	detachInput = attachJsonlLineReader(process.stdin, onLine);

	try {
		return await new Promise<never>(() => {});
	} finally {
		for (const { signal, handler } of handlers) process.off(signal, handler);
		detachInput();
	}
}
