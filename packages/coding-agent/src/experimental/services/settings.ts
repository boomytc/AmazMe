import { type Context, defineService, type ReplicatedState } from "@amazme/chord";

/**
 * One editable field of the agent's settings. The host publishes the catalogue, so a presentation
 * renders exactly the fields the host can read and write; it never invents one.
 *
 * The catalogue carries identities and tokens, not copy: `id` and `group` name the field and its
 * heading, and an enum's `options` are its stored values. A presentation owns the labels and
 * descriptions for those identities in its own language, the way the TUI's settings selector does.
 */
export interface SettingDescriptor {
	id: string;
	/** The canonical heading token the field is listed under, e.g. `conversation`. */
	group: string;
	kind: "boolean" | "enum" | "number" | "string";
	/** An enum's stored values, in presentation order. */
	options?: string[];
	min?: number;
	step?: number;
	/** The settings.json key the value lands in, shown so the file stays discoverable. */
	field: string;
	/** The settings file sets this key itself; an unset field shows the built-in default. */
	explicit: boolean;
	/** The effective value, serialized the way the control writes it back. */
	value: string;
}

export interface SettingsError {
	scope: "global" | "project";
	path?: string;
	message: string;
}

export interface SettingsState {
	revision: number;
	agentDir: string;
	cwd: string;
	paths: { global: string; project?: string };
	projectTrusted: boolean;
	/** The fields the host can edit, in presentation order. */
	descriptors: SettingDescriptor[];
	errors: SettingsError[];
}

/** The agent's settings as fields: read the catalogue, write one value, re-read the files. */
export interface Settings {
	readonly state: ReplicatedState<SettingsState>;
	/** Apply one catalogue field. `value` is the control's serialized form. */
	set(id: string, value: string, context: Context): Promise<void>;
	/** Re-read the settings files, discarding what another process changed. */
	reload(context: Context): Promise<void>;
}

export const Settings = defineService<Settings>("amazme.settings");

/**
 * The attached Session worker's own settings, exposed so a write from another process can be picked
 * up by the running Session. The worker reads its settings when it starts; without a reload the
 * running turn keeps using the copy it loaded.
 */
export interface SessionSettings {
	reload(context: Context): Promise<void>;
}

export const SessionSettings = defineService<SessionSettings>("amazme.session-settings");
