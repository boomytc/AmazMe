import type { AgentState } from "@amazme/durable";
import { createToolNameMatcher } from "@amazme/durable/tool-names";
import { applyToolModifiers, DEFAULT_TOOL_NAMES, getToolListError, isToolModifier } from "./settings-manager.ts";
import { allToolNames } from "./tool-names.ts";

export interface ToolSelectionOptions {
	readonly tools?: readonly string[];
	readonly noTools?: "all" | "builtin";
	readonly excludeTools?: readonly string[];
}

export function getToolSelectionError(options: ToolSelectionOptions): string | undefined {
	if (options.noTools !== undefined && options.noTools !== "all" && options.noTools !== "builtin")
		return "noTools must be all or builtin";
	if (options.tools !== undefined) {
		const error = getToolListError(options.tools);
		if (error !== undefined) return error;
	}
	if (options.excludeTools !== undefined) {
		const error = getToolListError(options.excludeTools);
		if (error !== undefined) return `excludeTools: ${error}`;
		if (options.excludeTools.some(isToolModifier)) return "excludeTools accepts only plain names or patterns";
	}
	return undefined;
}

export function toolActivationEdits(
	configured: readonly string[] | undefined,
	modifiers: readonly string[] | undefined,
): Map<string, boolean> {
	return new Map(
		[...(Array.isArray(configured) ? configured : []), ...(modifiers ?? [])]
			.filter(isToolModifier)
			.map((entry) => [entry.slice(1), entry.startsWith("+")] as const),
	);
}

/** Shared CLI/SDK activation and allowlist calculation; extensions apply their default activation separately. */
export function resolveToolSelection(options: ToolSelectionOptions, defaults?: readonly string[]) {
	const defaultToolNames = options.noTools ? [] : (defaults ?? DEFAULT_TOOL_NAMES);
	const toolModifiers = options.tools?.some(isToolModifier) ? [...options.tools] : undefined;
	const selectedToolNames = toolModifiers
		? applyToolModifiers(defaultToolNames, toolModifiers)
		: options.tools?.slice();
	const allowedToolNames = toolModifiers
		? options.noTools === "all"
			? selectedToolNames
			: undefined
		: (options.tools?.slice() ?? (options.noTools === "all" ? [] : undefined));
	const excluded = options.excludeTools === undefined ? undefined : createToolNameMatcher(options.excludeTools);
	const initialActiveToolNames = (selectedToolNames ?? defaultToolNames).filter((name) => !excluded?.(name));
	return { toolModifiers, allowedToolNames, initialActiveToolNames };
}

/** A single persistent Durable selector; patterns and future exact-name activation remain unresolved until use. */
export function durableToolSelection(
	options: ToolSelectionOptions,
	defaults?: readonly string[],
	configured?: readonly string[],
): NonNullable<AgentState["tools"]> {
	const selected = resolveToolSelection(options, defaults);
	const exclude = [...(options.excludeTools ?? [])];
	if (selected.allowedToolNames !== undefined)
		return { allow: selected.allowedToolNames, ...(exclude.length === 0 ? {} : { exclude }) };
	const remove: string[] = [];
	const active = createToolNameMatcher(selected.initialActiveToolNames);
	remove.push(...[...allToolNames].filter((name) => !active(name)));
	for (const [name, enabled] of toolActivationEdits(configured, selected.toolModifiers)) {
		if (!enabled && !active(name)) remove.push(name);
	}
	return {
		...(selected.initialActiveToolNames.length === 0 ? {} : { add: selected.initialActiveToolNames }),
		remove: [...new Set(remove)],
		...(exclude.length === 0 ? {} : { exclude }),
	};
}
