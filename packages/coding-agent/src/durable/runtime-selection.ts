import type { AppMode } from "../core/project-trust.ts";

export type HeadlessRuntime = "durable" | "legacy";

export interface HeadlessRuntimeSelection {
	readonly appMode: AppMode;
	/** `--help` and `--list-models` are metadata commands, not headless agent runs. */
	readonly metadataOnly: boolean;
	readonly explicit: "durable" | "legacy" | undefined;
	/** `--session`, `--session-id`, or `--fork`: JSONL-only selection. */
	readonly jsonlSessionFlags: boolean;
	/** Inline SDK extension factories; the Durable runtime loads native facets instead. */
	readonly inlineFactories: boolean;
	readonly continuing: boolean;
	/** Whether the selected project and session root already has a Durable session. */
	readonly hasDurableSession: boolean;
}

/**
 * Default the headless entry points to Durable, keeping the JSONL runtime for the cases that
 * cannot be represented yet. An explicit `AMAZME_RUNTIME=durable` still selects Durable so the
 * caller gets a clear rejection instead of a silent fallback.
 */
export function selectHeadlessRuntime(input: HeadlessRuntimeSelection): HeadlessRuntime {
	if (input.metadataOnly || input.appMode === "interactive") return "legacy";
	if (input.explicit === "legacy") return "legacy";
	if (input.explicit === "durable") return "durable";
	if (input.jsonlSessionFlags || input.inlineFactories) return "legacy";
	if (input.continuing && !input.hasDurableSession) return "legacy";
	return "durable";
}
