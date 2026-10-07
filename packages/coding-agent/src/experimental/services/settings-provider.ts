import { type Context, type MutableReplicatedState } from "@amazme/chord";
import type { ThinkingLevel } from "@amazme/agent";
import type { Transport } from "@amazme/ai";
import {
	APPEARANCE_PREFERENCES,
	type AppearancePreference,
	TOOL_APPROVAL_MODES,
	type ToolApprovalMode,
	LOCALE_PREFERENCES,
	type LocalePreference,
	type SettingsManager,
} from "../../core/settings-manager.ts";
import type { SettingDescriptor, SettingsError, SettingsState } from "./settings.ts";

/**
 * The settings catalogue: one entry per field the web client may edit, with the getter and setter
 * that define it. The host publishes the catalogue's identities, so the page renders exactly the
 * editable surface and a write is a call to a typed setter rather than an arbitrary JSON edit. The
 * page owns the labels, descriptions, and option names for those identities in both languages.
 */
interface SettingSpec {
	/** Stable catalogue id, and the page's key for this field's copy. */
	readonly id: string;
	/** The canonical heading token the field is listed under. */
	readonly group: string;
	readonly kind: SettingDescriptor["kind"];
	/** The settings.json key this field lives under. */
	readonly field: string;
	/** The nested key, for a field inside an object such as `compaction`. */
	readonly nested?: string;
	/** An enum's stored values, in presentation order. */
	readonly options?: readonly string[];
	readonly min?: number;
	readonly step?: number;
	read(manager: SettingsManager): string;
	write(manager: SettingsManager, value: string): void;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const TRANSPORTS: readonly Transport[] = ["auto", "websocket", "sse"];
const STEERING_MODES = ["one-at-a-time", "all"] as const;
const FOLLOW_UP_MODES = ["one-at-a-time", "all"] as const;
const CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const;
const MERMAID_MODES = ["off", "final", "streaming"] as const;
const TRUST_MODES = ["ask", "always", "never"] as const;
const QUIET_MODES = ["false", "header", "true"] as const;

function enumValue(options: readonly string[], value: string): string {
	return options.includes(value) ? value : (options[0] ?? "");
}

const SPECS: readonly SettingSpec[] = [
	{
		id: "locale",
		group: "interface",
		kind: "enum",
		field: "locale",
		options: LOCALE_PREFERENCES,
		read: (manager) => manager.getLocalePreference(),
		write: (manager, value) => manager.setLocalePreference(value as LocalePreference),
	},
	{
		id: "appearance",
		group: "interface",
		kind: "enum",
		field: "appearance",
		options: APPEARANCE_PREFERENCES,
		read: (manager) => manager.getAppearancePreference(),
		write: (manager, value) => manager.setAppearancePreference(value as AppearancePreference),
	},
	{
		id: "showWelcome",
		group: "interface",
		kind: "boolean",
		field: "showWelcome",
		read: (manager) => String(manager.getShowWelcome()),
		write: (manager, value) => manager.setShowWelcome(value === "true"),
	},
	{
		id: "toolApproval",
		group: "approvals",
		kind: "enum",
		field: "toolApproval",
		options: TOOL_APPROVAL_MODES,
		read: (manager) => manager.getToolApprovalMode(),
		write: (manager, value) => manager.setToolApprovalMode(value as ToolApprovalMode),
	},
	{
		id: "compactionEnabled",
		group: "conversation",
		kind: "boolean",
		field: "compaction",
		nested: "enabled",
		read: (manager) => String(manager.getCompactionEnabled()),
		write: (manager, value) => manager.setCompactionEnabled(value === "true"),
	},
	{
		id: "steeringMode",
		group: "conversation",
		kind: "enum",
		field: "steeringMode",
		options: STEERING_MODES,
		read: (manager) => enumValue(STEERING_MODES, manager.getSteeringMode()),
		write: (manager, value) => manager.setSteeringMode(value as "all" | "one-at-a-time"),
	},
	{
		id: "followUpMode",
		group: "conversation",
		kind: "enum",
		field: "followUpMode",
		options: FOLLOW_UP_MODES,
		read: (manager) => enumValue(FOLLOW_UP_MODES, manager.getFollowUpMode()),
		write: (manager, value) => manager.setFollowUpMode(value as "all" | "one-at-a-time"),
	},
	{
		id: "hideThinkingBlock",
		group: "conversation",
		kind: "boolean",
		field: "hideThinkingBlock",
		read: (manager) => String(manager.getHideThinkingBlock()),
		write: (manager, value) => manager.setHideThinkingBlock(value === "true"),
	},
	{
		id: "defaultThinkingLevel",
		group: "models-reasoning",
		kind: "enum",
		field: "defaultThinkingLevel",
		options: THINKING_LEVELS,
		read: (manager) => enumValue(THINKING_LEVELS, manager.getDefaultThinkingLevel() ?? "off"),
		write: (manager, value) => manager.setDefaultThinkingLevel(value as ThinkingLevel),
	},
	{
		id: "cacheWarming",
		group: "models-reasoning",
		kind: "enum",
		field: "cacheWarming",
		options: CACHE_WARMING_MODES,
		read: (manager) => enumValue(CACHE_WARMING_MODES, manager.getCacheWarmingMode()),
		write: (manager, value) => manager.setCacheWarmingMode(value as "off" | "streaming" | "idle"),
	},
	{
		id: "showCacheMissNotices",
		group: "models-reasoning",
		kind: "boolean",
		field: "showCacheMissNotices",
		read: (manager) => String(manager.getShowCacheMissNotices()),
		write: (manager, value) => manager.setShowCacheMissNotices(value === "true"),
	},
	{
		id: "enableSkillCommands",
		group: "skills-tools",
		kind: "boolean",
		field: "enableSkillCommands",
		read: (manager) => String(manager.getEnableSkillCommands()),
		write: (manager, value) => manager.setEnableSkillCommands(value === "true"),
	},
	{
		id: "transport",
		group: "network-retries",
		kind: "enum",
		field: "transport",
		options: TRANSPORTS,
		read: (manager) => enumValue(TRANSPORTS, manager.getTransport()),
		write: (manager, value) => manager.setTransport(value as Transport),
	},
	{
		id: "httpIdleTimeoutMs",
		group: "network-retries",
		kind: "number",
		field: "httpIdleTimeoutMs",
		min: 0,
		step: 1000,
		read: (manager) => String(manager.getHttpIdleTimeoutMs()),
		write: (manager, value) => manager.setHttpIdleTimeoutMs(Number(value)),
	},
	{
		id: "retryEnabled",
		group: "network-retries",
		kind: "boolean",
		field: "retry",
		nested: "enabled",
		read: (manager) => String(manager.getRetryEnabled()),
		write: (manager, value) => manager.setRetryEnabled(value === "true"),
	},
	{
		id: "imageAutoResize",
		group: "images-rendering",
		kind: "boolean",
		field: "images",
		nested: "autoResize",
		read: (manager) => String(manager.getImageAutoResize()),
		write: (manager, value) => manager.setImageAutoResize(value === "true"),
	},
	{
		id: "blockImages",
		group: "images-rendering",
		kind: "boolean",
		field: "images",
		nested: "blockImages",
		read: (manager) => String(manager.getBlockImages()),
		write: (manager, value) => manager.setBlockImages(value === "true"),
	},
	{
		id: "mermaidRenderingMode",
		group: "images-rendering",
		kind: "enum",
		field: "markdown",
		nested: "mermaid",
		options: MERMAID_MODES,
		read: (manager) => enumValue(MERMAID_MODES, manager.getMermaidRenderingMode()),
		write: (manager, value) => manager.setMermaidRenderingMode(value as "off" | "final" | "streaming"),
	},
	{
		id: "defaultProjectTrust",
		group: "projects",
		kind: "enum",
		field: "defaultProjectTrust",
		options: TRUST_MODES,
		read: (manager) => enumValue(TRUST_MODES, manager.getDefaultProjectTrust()),
		write: (manager, value) => manager.setDefaultProjectTrust(value as "ask" | "always" | "never"),
	},
	{
		id: "quietStartup",
		group: "projects",
		kind: "enum",
		field: "quietStartup",
		options: QUIET_MODES,
		read: (manager) => {
			const quiet = manager.getQuietStartup();
			return quiet === "header" ? "header" : String(quiet);
		},
		write: (manager, value) =>
			manager.setQuietStartup(value === "header" ? "header" : (value as "true" | "false") === "true"),
	},
	{
		id: "shellPath",
		group: "shell",
		kind: "string",
		field: "shellPath",
		read: (manager) => manager.getShellPath() ?? "",
		write: (manager, value) => manager.setShellPath(value.length === 0 ? undefined : value),
	},
	{
		id: "shellCommandPrefix",
		group: "shell",
		kind: "string",
		field: "shellCommandPrefix",
		read: (manager) => manager.getShellCommandPrefix() ?? "",
		write: (manager, value) => manager.setShellCommandPrefix(value.length === 0 ? undefined : value),
	},
];

function hasField(settings: Record<string, unknown>, spec: SettingSpec): boolean {
	const value = settings[spec.field];
	if (spec.nested === undefined) return value !== undefined;
	return (
		typeof value === "object" && value !== null && (value as Record<string, unknown>)[spec.nested] !== undefined
	);
}

/** The catalogue with each field's effective value and whether a settings file sets it itself. */
export function describeSettings(manager: SettingsManager): SettingDescriptor[] {
	const globalSettings = manager.getGlobalSettings() as Record<string, unknown>;
	const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
	return SPECS.map((spec) => ({
		id: spec.id,
		group: spec.group,
		kind: spec.kind,
		...(spec.options === undefined ? {} : { options: [...spec.options] }),
		...(spec.min === undefined ? {} : { min: spec.min }),
		...(spec.step === undefined ? {} : { step: spec.step }),
		field: spec.nested === undefined ? spec.field : `${spec.field}.${spec.nested}`,
		explicit: hasField(globalSettings, spec) || hasField(projectSettings, spec),
		value: spec.read(manager),
	}));
}

function coerce(spec: SettingSpec, value: string): string {
	switch (spec.kind) {
		case "boolean":
			if (value !== "true" && value !== "false") throw new Error(`${spec.id} takes true or false`);
			return value;
		case "number": {
			const parsed = Number(value);
			if (!Number.isSafeInteger(parsed) || parsed < (spec.min ?? Number.NEGATIVE_INFINITY)) {
				throw new Error(`${spec.id} takes a whole number${spec.min === undefined ? "" : ` ≥ ${spec.min}`}`);
			}
			return String(parsed);
		}
		case "enum":
			if (!spec.options?.includes(value)) {
				throw new Error(`${spec.id} takes one of: ${(spec.options ?? []).join(", ")}`);
			}
			return value;
		case "string":
			return value;
	}
}

/** The manager's storage errors as the state carries them. */
export function settingsErrors(manager: SettingsManager): SettingsError[] {
	return manager.drainErrors().map((error) => ({
		scope: error.scope,
		...(error.path === undefined ? {} : { path: error.path }),
		message: error.error.message,
	}));
}

/**
 * Apply one catalogue field to the manager and wait for the settings file to land. A storage error
 * the write produced is returned; an invalid value throws, because that is the caller's mistake.
 */
export async function applySetting(
	manager: SettingsManager,
	id: string,
	value: string,
): Promise<SettingsError[]> {
	const spec = SPECS.find((candidate) => candidate.id === id);
	if (spec === undefined) throw new Error(`Unknown setting: ${id}`);
	manager.drainErrors();
	spec.write(manager, coerce(spec, value));
	await manager.flush();
	return settingsErrors(manager);
}

/** The replicated snapshot of the manager's fields, plus the files they came from. */
export function settingsSnapshot(options: {
	readonly manager: SettingsManager;
	readonly agentDir: string;
	readonly cwd: string;
	readonly paths: { readonly global: string; readonly project?: string };
	readonly errors: readonly SettingsError[];
}): Omit<SettingsState, "revision"> {
	return {
		agentDir: options.agentDir,
		cwd: options.cwd,
		paths: options.paths,
		projectTrusted: options.manager.isProjectTrusted(),
		descriptors: describeSettings(options.manager),
		errors: [...options.errors],
	};
}

/** Publish a fresh snapshot; every mutation ends here so a client sees one state per change. */
export function publishSettings(
	state: MutableReplicatedState<SettingsState>,
	context: Context,
	options: {
		readonly manager: SettingsManager;
		readonly agentDir: string;
		readonly cwd: string;
		readonly paths: { readonly global: string; readonly project?: string };
		readonly errors: readonly SettingsError[];
	},
): void {
	const snapshot = settingsSnapshot(options);
	state.change(context, (draft) => {
		draft.revision += 1;
		draft.agentDir = snapshot.agentDir;
		draft.cwd = snapshot.cwd;
		draft.paths = snapshot.paths;
		draft.projectTrusted = snapshot.projectTrusted;
		draft.descriptors = [...snapshot.descriptors];
		draft.errors = [...snapshot.errors];
	});
}
