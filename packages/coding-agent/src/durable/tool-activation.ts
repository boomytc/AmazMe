import type { Context } from "@amazme/chord";
import { AgentDoc, type AgentState, type Conversation } from "@amazme/durable";
import { durableToolSelection } from "../core/tool-selection.ts";
import type { SettingsManager } from "../core/settings-manager.ts";

export function intendedToolNames(selection: NonNullable<AgentState["tools"]>): readonly string[] {
	if (Array.isArray(selection)) return selection;
	return selection.allow ?? selection.only ?? selection.add ?? [];
}

/** Enable names added to the saved tool selection. Names the conversation already turned off stay off. */
export async function enableNamedTools(
	conversation: Conversation,
	names: readonly string[],
	context: Context,
): Promise<void> {
	if (names.length === 0) return;
	await conversation.commit(async (tx) => {
		const state = await tx.doc(AgentDoc, conversation.id);
		const tools = state.tools;
		const append = (selected: string[]): void => {
			for (const name of names) if (!selected.includes(name)) selected.push(name);
		};
		if (tools === undefined) {
			state.tools = { add: [...names] };
			return;
		}
		if (Array.isArray(tools)) {
			append(tools);
			return;
		}
		if (tools.only !== undefined) append(tools.only);
		else if (tools.allow !== undefined) append(tools.allow);
		else {
			if (tools.add === undefined) tools.add = [];
			append(tools.add);
		}
		if (tools.remove !== undefined) tools.remove = tools.remove.filter((name) => !names.includes(name));
	}, context);
}

/** Remembers which saved tool names each conversation has already been offered. */
export function createToolReloadTracker(initial: NonNullable<AgentState["tools"]>): {
	apply(conversation: Conversation, next: NonNullable<AgentState["tools"]>, context: Context): Promise<void>;
} {
	const baseline = new Set(intendedToolNames(initial));
	const applied = new Map<string, Set<string>>();
	return {
		async apply(conversation, next, context) {
			const key = String(conversation.id);
			let known = applied.get(key);
			if (known === undefined) {
				known = new Set(baseline);
				applied.set(key, known);
			}
			const nextNames = intendedToolNames(next);
			const added = nextNames.filter((name) => !known.has(name));
			if (added.length > 0) await enableNamedTools(conversation, added, context);
			known.clear();
			for (const name of nextNames) known.add(name);
		},
	};
}

/** Reconnect MCP and enable tools newly added to the saved selection for one conversation. */
export async function reloadConversationResources(input: {
	readonly context: Context;
	readonly settings?: SettingsManager;
	readonly mcp?: { reload(context: Context): Promise<void> };
	readonly conversation: Conversation;
	readonly tracker?: ReturnType<typeof createToolReloadTracker>;
	readonly align?: (conversation: Conversation, context: Context) => Promise<void>;
}): Promise<void> {
	await input.mcp?.reload(input.context);
	const settings = input.settings;
	if (settings !== undefined && input.tracker !== undefined) {
		await input.tracker.apply(
			input.conversation,
			durableToolSelection({}, settings.getDefaultTools(), settings.getSettings().defaultTools),
			input.context,
		);
	}
	await input.align?.(input.conversation, input.context);
}
