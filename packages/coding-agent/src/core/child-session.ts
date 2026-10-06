import { Agent, type AgentMessage } from "@amazme/agent";
import type { Model } from "@amazme/ai/compat";
import { streamSimple } from "@amazme/ai/compat";
import type { AgentSession, AgentSessionConfig, AgentSessionEvent } from "./agent-session.ts";
import { createExtensionRuntime } from "./extensions/loader.ts";
import type { LoadExtensionsResult } from "./extensions/types.ts";
import { convertToLlm } from "./messages.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";

export type ChildAgentStatus = "running" | "finished" | "failed" | "cancelled";

export interface ChildRecord {
	id: string;
	description: string;
	modelId: string;
	status: ChildAgentStatus;
	activity: string;
	startedAt: number;
	endedAt?: number;
	transcript: string[];
	cancel: () => void;
}

/** Parent-scrollback rows for child agents. The interactive surface reads this book. */
export class ChildAgentBook {
	readonly records: ChildRecord[] = [];
	openId: string | undefined;
	highlightId: string | undefined;
	tasksOpen = false;
	private readonly listeners = new Set<() => void>();

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	add(record: ChildRecord): void {
		this.records.push(record);
		this.touch();
	}

	touch(): void {
		for (const listener of this.listeners) listener();
	}

	open(id: string): void {
		this.openId = id;
		this.touch();
	}

	close(): void {
		this.openId = undefined;
		this.touch();
	}
}

export function childLifecycleLine(record: ChildRecord): string {
	const quoted = `"${record.description}"`;
	if (record.status === "running") {
		const suffix = record.activity ? ` · ${record.activity}` : "";
		return `Subagent running: ${quoted} (${record.modelId})${suffix}`;
	}
	return `Subagent ${record.status}: ${quoted} (${record.modelId})`;
}

export function childFrameLines(record: ChildRecord, now = Date.now()): string[] {
	const elapsedMs = (record.endedAt ?? now) - record.startedAt;
	const elapsed = `${Math.max(0, Math.floor(elapsedMs / 1000))}s`;
	return [`${record.status} ${record.description} ${record.modelId} ${elapsed}`, ...record.transcript];
}

export interface ChildSessionUpdate {
	activity?: string;
	transcript?: string[];
	status?: "finished" | "failed" | "cancelled";
	endedAt?: number;
}

function emptyExtensions(): LoadExtensionsResult {
	return { extensions: [], errors: [], runtime: createExtensionRuntime() };
}

function emptyResourceLoader(): ResourceLoader {
	const extensions = emptyExtensions();
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function transcriptOf(messages: readonly AgentMessage[]): string[] {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((part) => part.type === "text" && "text" in part)
						.map((part) => (part as { text: string }).text)
						.join("\n");
		if (text.trim()) lines.push(text);
	}
	return lines;
}

/**
 * Run a child session on the parent's model. The caller owns the lifecycle row;
 * this function only drives the session and reports activity.
 */
export async function launchChildAgent(options: {
	cwd: string;
	model: Model<any>;
	modelRuntime: ModelRuntime;
	prompt: string;
	createSession: (config: AgentSessionConfig) => AgentSession;
	onSession: (session: AgentSession) => void;
	onUpdate: (update: ChildSessionUpdate) => void;
	isCancelled: () => boolean;
}): Promise<void> {
	const agent = new Agent({
		getApiKey: async () => (await options.modelRuntime.getAuth(options.model))?.auth.apiKey,
		streamFn: streamSimple,
		initialState: {
			model: options.model,
			systemPrompt: "You are a child agent. Complete the task and answer briefly.",
			tools: [],
		},
		convertToLlm,
	});
	const session = options.createSession({
		agent,
		sessionManager: SessionManager.inMemory(options.cwd),
		settingsManager: SettingsManager.inMemory(),
		cwd: options.cwd,
		modelRuntime: options.modelRuntime,
		resourceLoader: emptyResourceLoader(),
		allowedToolNames: [],
		recordBackgroundCompletions: false,
	});
	options.onSession(session);
	const publishTranscript = () => options.onUpdate({ transcript: transcriptOf(session.messages) });
	session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "turn_start") options.onUpdate({ activity: "Thinking" });
		if (event.type === "tool_execution_start") options.onUpdate({ activity: `Running: ${event.toolName}` });
		if (event.type === "message_end") publishTranscript();
	});
	try {
		await session.prompt(options.prompt);
		publishTranscript();
		if (options.isCancelled()) return;
		const assistant = session.messages.findLast((message) => message.role === "assistant");
		const stopReason = assistant && assistant.role === "assistant" ? assistant.stopReason : undefined;
		if (stopReason === "aborted") options.onUpdate({ status: "cancelled", endedAt: Date.now() });
		else if (stopReason === "error") options.onUpdate({ status: "failed", endedAt: Date.now() });
		else options.onUpdate({ status: "finished", endedAt: Date.now(), activity: "" });
	} catch {
		if (!options.isCancelled()) options.onUpdate({ status: "failed", endedAt: Date.now() });
	} finally {
		session.dispose();
	}
}
