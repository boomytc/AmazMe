import { copyJson, type Draft } from "@amazme/chord";
import { defineDoc } from "../documents.ts";
import { createToolNameMatcher } from "../tool-names.ts";
import type { ConversationId, ConversationRecord, Tx } from "../types.ts";
import type {
	Agent,
	AgentChange,
	AgentState,
	CompactionPolicy,
	ConversationRetryPolicy,
	Extension,
	HarnessSettings,
	ProgressPolicy,
	PromptSection,
	RegistrySnapshot,
	Settings,
	ToolRegistration,
} from "./types.ts";

export const DEFAULT_RETRY_POLICY: ConversationRetryPolicy = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxAgentDelayMs: 60000,
};

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	backgroundTokens: 32768,
};

export const DEFAULT_PROGRESS_POLICY: ProgressPolicy = {
	partialIntervalMs: 100,
	outputIntervalMs: 100,
};

/** The reserved section key of the agent's `instructions`. */
export const INSTRUCTIONS_KEY = "instructions";

/** Built-in agent document; rewindable so forks start from the agent at their fork entry. */
export const AgentDoc = defineDoc<AgentState>({
	kind: "amazme.agent",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({}),
	checkpointWhen: () => true,
});

/** Default `settings.contextRetentionMs`: ten minutes. */
const DEFAULT_CONTEXT_RETENTION_MS = 600_000;

/** Resolve the host settings: every field over its built-in default, object fields merged. */
export function resolveSettings(settings: HarnessSettings | undefined): Settings {
	const extensions = settings?.extensions;
	return {
		...(extensions === undefined ? {} : { extensions }),
		stream: { ...settings?.stream },
		retry: { ...DEFAULT_RETRY_POLICY, ...settings?.retry },
		compaction: { ...DEFAULT_COMPACTION_POLICY, ...settings?.compaction },
		// Field by field, so an explicitly undefined interval keeps its default.
		progress: {
			partialIntervalMs: settings?.progress?.partialIntervalMs ?? DEFAULT_PROGRESS_POLICY.partialIntervalMs,
			outputIntervalMs: settings?.progress?.outputIntervalMs ?? DEFAULT_PROGRESS_POLICY.outputIntervalMs,
		},
		toolExecution: settings?.toolExecution ?? "parallel",
		steeringMode: settings?.steeringMode ?? "one-at-a-time",
		followUpMode: settings?.followUpMode ?? "one-at-a-time",
		contextRetentionMs: settings?.contextRetentionMs ?? DEFAULT_CONTEXT_RETENTION_MS,
	};
}

/** Apply one change to `pi.agent`: a given field replaces the stored one, `null` clears it, `undefined` changes nothing. */
export async function configure(tx: Tx, conversationId: ConversationId, change: AgentChange): Promise<void> {
	const state = await tx.doc(AgentDoc, conversationId);
	applyChange(state, change);
}

/**
 * A tool round can activate an inactive or newly discovered tool. Explicit lists extend, default selectors gain
 * additions, and exact-name activation removals are cleared. Pattern removals remain in effect.
 */
export async function addTools(tx: Tx, conversationId: ConversationId, added: readonly string[]): Promise<void> {
	const state = await tx.doc(AgentDoc, conversationId);
	const tools = state.tools;
	const allowed =
		tools !== undefined && !Array.isArray(tools) && tools.allow !== undefined
			? createToolNameMatcher(tools.allow)
			: undefined;
	const excluded =
		tools !== undefined && !Array.isArray(tools) && tools.exclude !== undefined
			? createToolNameMatcher(tools.exclude)
			: undefined;
	const permitted = added.filter((name) => (allowed === undefined || allowed(name)) && !excluded?.(name));
	if (permitted.length === 0) return;
	if (tools === undefined) {
		state.tools = { add: permitted };
		return;
	}
	if (Array.isArray(tools)) {
		const active = createToolNameMatcher(tools);
		for (const name of permitted) if (!active(name)) tools.push(name);
	} else {
		if (tools.only !== undefined || tools.allow === undefined) {
			if (tools.only === undefined && tools.add === undefined) tools.add = [];
			// Document assignment adopts a copy; read the mounted array again before mutating it.
			const selected = tools.only ?? tools.add!;
			const active = createToolNameMatcher(selected);
			for (const name of permitted) if (!active(name) && !selected.includes(name)) selected.push(name);
		}
		if (tools.remove !== undefined) tools.remove = tools.remove.filter((name) => !permitted.includes(name));
	}
}

function applyChange(state: Draft<AgentState>, change: AgentChange): void {
	const set = <K extends keyof AgentState>(key: K, value: AgentState[K] | null | undefined) => {
		if (value === undefined) return;
		if (value === null) delete state[key];
		else state[key] = value as Draft<AgentState>[K];
	};
	set("model", change.model === undefined || change.model === null ? change.model : { ...change.model });
	set("thinkingLevel", change.thinkingLevel);
	const extensions = change.extensions;
	set(
		"extensions",
		extensions === undefined || extensions === null
			? extensions
			: isList(extensions)
				? names(extensions)
				: {
						...(extensions.add === undefined ? {} : { add: names(extensions.add) }),
						...(extensions.remove === undefined ? {} : { remove: names(extensions.remove) }),
					},
	);
	const tools = change.tools;
	set(
		"tools",
		tools === undefined || tools === null
			? tools
			: isList(tools)
				? names(tools)
				: {
						...(tools.only === undefined ? {} : { only: names(tools.only) }),
						...(tools.allow === undefined ? {} : { allow: names(tools.allow) }),
						...(tools.add === undefined ? {} : { add: names(tools.add) }),
						...(tools.remove === undefined ? {} : { remove: names(tools.remove) }),
						...(tools.exclude === undefined ? {} : { exclude: names(tools.exclude) }),
					},
	);
	set("instructions", change.instructions);
	set("cwd", change.cwd);
}

function isList<T>(value: readonly T[] | object): value is readonly T[] {
	return Array.isArray(value);
}

function names(items: readonly { readonly name: string }[]): string[] {
	return items.map((item) => item.name);
}

/**
 * Built-in part of every Harness commit that creates or forks a conversation, for `pi.agent`: a fork keeps its `asOf`
 * copy; a new task-owned conversation copies the stored agent of its owner task's conversation; a new ownerless one
 * starts empty.
 */
export async function createAgent(tx: Tx, conversation: ConversationRecord): Promise<void> {
	if (conversation.parent !== undefined) return;
	const agent = await tx.doc(AgentDoc, conversation.id);
	if (conversation.owner === undefined) return;
	const owner = await tx.doc(AgentDoc, conversation.owner.conversationId);
	Object.assign(agent, copyJson(owner) as AgentState);
}

/** Handlers of the selected extensions' hooks for a task name, in extension order. */
export function agentHooks(agent: Agent, taskName: string): object[] {
	const handlers: object[] = [];
	for (const extension of agent.extensions) {
		for (const hook of extension.hooks ?? []) if (hook.task === taskName) handlers.push(hook.handlers);
	}
	return handlers;
}

/**
 * Resolve an agent from its stored state (absent: every field unset), a registry snapshot, and resolved settings. A
 * wrapper that throws or renames drops its target and is reported; a wrapper without a target does nothing.
 */
export function resolveAgent<Tool extends ToolRegistration>(
	state: Readonly<AgentState> | undefined,
	snapshot: RegistrySnapshot<Tool>,
	settings: Settings,
	report: (error: unknown) => void,
): Agent<Tool> {
	const extensions = selectExtensions(state?.extensions, snapshot, settings);

	const composed = new Map<string, Tool>();
	for (const extension of extensions) for (const tool of extension.tools ?? []) composed.set(tool.name, tool);
	const sections = new Map<string, PromptSection<Tool>>();
	for (const extension of extensions) {
		for (const section of extension.sections ?? []) sections.set(section.key, section);
	}
	for (const extension of extensions) {
		for (const wrap of extension.wraps ?? []) {
			if ("tool" in wrap)
				applyWrap(
					composed,
					wrap.tool,
					(tool) => wrap.wrap(tool),
					(tool) => tool.name,
					report,
				);
			else
				applyWrap(
					sections,
					wrap.section,
					(section) => wrap.wrap(section),
					(section) => section.key,
					report,
				);
		}
	}

	const filter = state?.tools;
	const selection = Array.isArray(filter) ? { only: filter } : filter;
	const initial = selection?.only ?? selection?.allow;
	let tools: Tool[] =
		initial === undefined ? [...composed.values()].filter((tool) => tool.defaultActive !== false) : [];
	const selected = new Set(tools.map((tool) => tool.name));
	for (const pattern of [...(initial ?? []), ...(selection?.add ?? [])]) {
		const matches = createToolNameMatcher([pattern]);
		for (const tool of composed.values())
			if (!selected.has(tool.name) && matches(tool.name)) {
				selected.add(tool.name);
				tools.push(tool);
			}
	}
	if (selection?.allow !== undefined) {
		const allowed = createToolNameMatcher(selection.allow);
		tools = tools.filter((tool) => allowed(tool.name));
	}
	if (selection?.remove !== undefined || selection?.exclude !== undefined) {
		const removed = createToolNameMatcher([...(selection.remove ?? []), ...(selection.exclude ?? [])]);
		tools = tools.filter((tool) => !removed(tool.name));
	}

	const instructions = state?.instructions;
	const agentSections = [...sections.values()];
	if (instructions !== undefined) agentSections.push({ key: INSTRUCTIONS_KEY, render: () => instructions });

	const agent: Agent<Tool> = {
		...(state?.model === undefined ? {} : { model: state.model }),
		thinkingLevel: state?.thinkingLevel ?? "off",
		extensions,
		tools,
		sections: agentSections,
		...(instructions === undefined ? {} : { instructions }),
		...(state?.cwd === undefined ? {} : { cwd: state.cwd }),
	};
	return agent;
}

/** Selected installed extensions: the stored array, or the default selection edited by `{ add, remove }`. */
function selectExtensions<Tool extends ToolRegistration>(
	stored: AgentState["extensions"],
	snapshot: RegistrySnapshot<Tool>,
	settings: Settings,
): Extension<Tool>[] {
	let selected: string[];
	if (Array.isArray(stored)) selected = stored;
	else {
		const base = settings.extensions?.map((extension) => extension.name) ?? snapshot.installed().map((e) => e.name);
		const edit = stored as { add?: string[]; remove?: string[] } | undefined;
		const removed = new Set(edit?.remove ?? []);
		selected = [...base, ...(edit?.add ?? [])].filter((name) => !removed.has(name));
	}
	const extensions: Extension<Tool>[] = [];
	for (const name of new Set(selected)) {
		const extension = snapshot.extension(name);
		if (extension !== undefined) extensions.push(extension);
	}
	return extensions;
}

function applyWrap<T>(
	items: Map<string, T>,
	target: string,
	wrap: (item: T) => T,
	nameOf: (item: T) => string,
	report: (error: unknown) => void,
): void {
	const item = items.get(target);
	if (item === undefined) return;
	try {
		const wrapped = wrap(item);
		if (nameOf(wrapped) !== target) throw new Error(`Wrapper renamed ${target} to ${nameOf(wrapped)}`);
		items.set(target, wrapped);
	} catch (error) {
		items.delete(target);
		report(error);
	}
}
