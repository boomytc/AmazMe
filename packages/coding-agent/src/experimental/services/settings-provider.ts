import { type Context, type MutableReplicatedState } from "@amazme/chord";
import type { ThinkingLevel } from "@amazme/agent";
import type { Transport } from "@amazme/ai";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { SettingDescriptor, SettingsError, SettingsState } from "./settings.ts";

/**
 * The settings catalogue: one entry per field the web client may edit, with the getter and setter
 * that define it. The host publishes these descriptors so the page renders exactly the editable
 * surface, and a write is a call to a typed setter rather than an arbitrary JSON edit.
 */
interface SettingSpec {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly group: string;
	readonly kind: SettingDescriptor["kind"];
	/** The settings.json key this field lives under. */
	readonly field: string;
	/** The nested key, for a field inside an object such as `compaction`. */
	readonly nested?: string;
	readonly options?: { value: string; label: string }[];
	readonly min?: number;
	readonly step?: number;
	readonly placeholder?: string;
	read(manager: SettingsManager): string;
	write(manager: SettingsManager, value: string): void;
}

function toggle(values: readonly (readonly [string, string])[]): { value: string; label: string }[] {
	return values.map(([value, label]) => ({ value, label }));
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const TRANSPORTS: readonly Transport[] = ["auto", "websocket", "sse"];

function enumValue<T extends string>(options: readonly { readonly value: string }[], value: T): string {
	return options.some((option) => option.value === value) ? value : (options[0]?.value ?? "");
}

const STEERING_OPTIONS = toggle([
	["one-at-a-time", "One at a time"],
	["all", "All at once"],
]);
const FOLLOW_UP_OPTIONS = toggle([
	["one-at-a-time", "One at a time"],
	["all", "All at once"],
]);
const THINKING_OPTIONS = toggle(THINKING_LEVELS.map((level) => [level, level] as [string, string]));
const TRANSPORT_OPTIONS = toggle(TRANSPORTS.map((transport) => [transport, transport] as [string, string]));
const CACHE_WARMING_OPTIONS = toggle([
	["off", "Off"],
	["streaming", "While streaming"],
	["idle", "Between runs too"],
]);
const MERMAID_OPTIONS = toggle([
	["off", "Off"],
	["final", "Settled answers"],
	["streaming", "While streaming"],
]);
const TRUST_OPTIONS = toggle([
	["ask", "Ask"],
	["always", "Always trust"],
	["never", "Never trust"],
]);
const QUIET_OPTIONS = toggle([
	["false", "Show startup output"],
	["header", "Header only"],
	["true", "Hide startup output"],
]);

const SPECS: readonly SettingSpec[] = [
	{
		id: "compactionEnabled",
		label: "Auto-compact",
		description: "Summarize the context when a conversation outgrows the model window.",
		group: "Conversation",
		kind: "boolean",
		field: "compaction",
		nested: "enabled",
		read: (manager) => String(manager.getCompactionEnabled()),
		write: (manager, value) => manager.setCompactionEnabled(value === "true"),
	},
	{
		id: "steeringMode",
		label: "Steering mode",
		description: "How messages sent while a turn runs are applied.",
		group: "Conversation",
		kind: "enum",
		field: "steeringMode",
		options: STEERING_OPTIONS,
		read: (manager) => enumValue(STEERING_OPTIONS, manager.getSteeringMode()),
		write: (manager, value) => manager.setSteeringMode(value as "all" | "one-at-a-time"),
	},
	{
		id: "followUpMode",
		label: "Follow-up mode",
		description: "How a message is queued when the turn would otherwise finish.",
		group: "Conversation",
		kind: "enum",
		field: "followUpMode",
		options: FOLLOW_UP_OPTIONS,
		read: (manager) => enumValue(FOLLOW_UP_OPTIONS, manager.getFollowUpMode()),
		write: (manager, value) => manager.setFollowUpMode(value as "all" | "one-at-a-time"),
	},
	{
		id: "hideThinkingBlock",
		label: "Hide thinking blocks",
		description: "Fold the model's reasoning away wherever it is rendered.",
		group: "Conversation",
		kind: "boolean",
		field: "hideThinkingBlock",
		read: (manager) => String(manager.getHideThinkingBlock()),
		write: (manager, value) => manager.setHideThinkingBlock(value === "true"),
	},
	{
		id: "defaultThinkingLevel",
		label: "Default thinking level",
		description: "The reasoning effort a conversation starts with.",
		group: "Models & reasoning",
		kind: "enum",
		field: "defaultThinkingLevel",
		options: THINKING_OPTIONS,
		read: (manager) => enumValue(THINKING_OPTIONS, manager.getDefaultThinkingLevel() ?? "off"),
		write: (manager, value) => manager.setDefaultThinkingLevel(value as ThinkingLevel),
	},
	{
		id: "cacheWarming",
		label: "Cache warming",
		description: "Pre-warm the prompt cache, which costs a call each time it runs.",
		group: "Models & reasoning",
		kind: "enum",
		field: "cacheWarming",
		options: CACHE_WARMING_OPTIONS,
		read: (manager) => enumValue(CACHE_WARMING_OPTIONS, manager.getCacheWarmingMode()),
		write: (manager, value) => manager.setCacheWarmingMode(value as "off" | "streaming" | "idle"),
	},
	{
		id: "showCacheMissNotices",
		label: "Cache miss notices",
		description: "Show the cost and provider recovery notices a cache miss produces.",
		group: "Models & reasoning",
		kind: "boolean",
		field: "showCacheMissNotices",
		read: (manager) => String(manager.getShowCacheMissNotices()),
		write: (manager, value) => manager.setShowCacheMissNotices(value === "true"),
	},
	{
		id: "enableSkillCommands",
		label: "Skills as commands",
		description: "Register every loaded skill as a slash command.",
		group: "Skills & tools",
		kind: "boolean",
		field: "enableSkillCommands",
		read: (manager) => String(manager.getEnableSkillCommands()),
		write: (manager, value) => manager.setEnableSkillCommands(value === "true"),
	},
	{
		id: "transport",
		label: "Transport",
		description: "How provider requests are carried.",
		group: "Network & retries",
		kind: "enum",
		field: "transport",
		options: TRANSPORT_OPTIONS,
		read: (manager) => enumValue(TRANSPORT_OPTIONS, manager.getTransport()),
		write: (manager, value) => manager.setTransport(value as Transport),
	},
	{
		id: "httpIdleTimeoutMs",
		label: "HTTP idle timeout (ms)",
		description: "Header and body idle timeout for provider requests; 0 disables it.",
		group: "Network & retries",
		kind: "number",
		field: "httpIdleTimeoutMs",
		min: 0,
		step: 1000,
		read: (manager) => String(manager.getHttpIdleTimeoutMs()),
		write: (manager, value) => manager.setHttpIdleTimeoutMs(Number(value)),
	},
	{
		id: "retryEnabled",
		label: "Provider retries",
		description: "Retry a provider request that failed with a retryable error.",
		group: "Network & retries",
		kind: "boolean",
		field: "retry",
		nested: "enabled",
		read: (manager) => String(manager.getRetryEnabled()),
		write: (manager, value) => manager.setRetryEnabled(value === "true"),
	},
	{
		id: "imageAutoResize",
		label: "Auto-resize images",
		description: "Scale attached images down for provider compatibility.",
		group: "Images & rendering",
		kind: "boolean",
		field: "images",
		nested: "autoResize",
		read: (manager) => String(manager.getImageAutoResize()),
		write: (manager, value) => manager.setImageAutoResize(value === "true"),
	},
	{
		id: "blockImages",
		label: "Block images",
		description: "Keep every image out of provider requests.",
		group: "Images & rendering",
		kind: "boolean",
		field: "images",
		nested: "blockImages",
		read: (manager) => String(manager.getBlockImages()),
		write: (manager, value) => manager.setBlockImages(value === "true"),
	},
	{
		id: "mermaidRenderingMode",
		label: "Mermaid diagrams",
		description: "When mermaid blocks in an answer are rendered as diagrams.",
		group: "Images & rendering",
		kind: "enum",
		field: "markdown",
		nested: "mermaid",
		options: MERMAID_OPTIONS,
		read: (manager) => enumValue(MERMAID_OPTIONS, manager.getMermaidRenderingMode()),
		write: (manager, value) => manager.setMermaidRenderingMode(value as "off" | "final" | "streaming"),
	},
	{
		id: "defaultProjectTrust",
		label: "Default project trust",
		description: "Whether a project's settings, extensions, and MCP servers load without being asked.",
		group: "Projects",
		kind: "enum",
		field: "defaultProjectTrust",
		options: TRUST_OPTIONS,
		read: (manager) => enumValue(TRUST_OPTIONS, manager.getDefaultProjectTrust()),
		write: (manager, value) => manager.setDefaultProjectTrust(value as "ask" | "always" | "never"),
	},
	{
		id: "quietStartup",
		label: "Startup output",
		description: "How much the CLI prints when a session starts.",
		group: "Projects",
		kind: "enum",
		field: "quietStartup",
		options: QUIET_OPTIONS,
		read: (manager) => {
			const quiet = manager.getQuietStartup();
			return quiet === "header" ? "header" : String(quiet);
		},
		write: (manager, value) =>
			manager.setQuietStartup(value === "header" ? "header" : (value as "true" | "false") === "true"),
	},
	{
		id: "shellPath",
		label: "Shell path",
		description: "Shell used for the bash tool; empty uses the platform default.",
		group: "Shell",
		kind: "string",
		field: "shellPath",
		placeholder: "System default",
		read: (manager) => manager.getShellPath() ?? "",
		write: (manager, value) => manager.setShellPath(value.length === 0 ? undefined : value),
	},
	{
		id: "shellCommandPrefix",
		label: "Shell command prefix",
		description: "Prepended to every bash command, for example to enable aliases.",
		group: "Shell",
		kind: "string",
		field: "shellCommandPrefix",
		placeholder: "None",
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
		label: spec.label,
		description: spec.description,
		group: spec.group,
		kind: spec.kind,
		...(spec.options === undefined ? {} : { options: spec.options }),
		...(spec.min === undefined ? {} : { min: spec.min }),
		...(spec.step === undefined ? {} : { step: spec.step }),
		...(spec.placeholder === undefined ? {} : { placeholder: spec.placeholder }),
		field: spec.nested === undefined ? spec.field : `${spec.field}.${spec.nested}`,
		explicit: hasField(globalSettings, spec) || hasField(projectSettings, spec),
		value: spec.read(manager),
	}));
}

function coerce(spec: SettingSpec, value: string): string {
	switch (spec.kind) {
		case "boolean":
			if (value !== "true" && value !== "false") throw new Error(`${spec.label} takes true or false`);
			return value;
		case "number": {
			const parsed = Number(value);
			if (!Number.isSafeInteger(parsed) || parsed < (spec.min ?? Number.NEGATIVE_INFINITY)) {
				throw new Error(`${spec.label} takes a whole number${spec.min === undefined ? "" : ` ≥ ${spec.min}`}`);
			}
			return String(parsed);
		}
		case "enum":
			if (!spec.options?.some((option) => option.value === value)) {
				throw new Error(`${spec.label} takes one of: ${(spec.options ?? []).map((o) => o.value).join(", ")}`);
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
