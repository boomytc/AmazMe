/**
 * The management surface's view model: the sidebar's navigation plus one panel description per
 * management area. A panel is described as groups of rows — a title, an optional value, controls,
 * and buttons — so the renderer needs no feature knowledge and a management area added later is
 * another pure builder here.
 */

/** The main area's views: the conversation, or one management panel. */
export type PanelId = "plugins" | "skills" | "settings";

export interface NavItem {
	/** "chat" or a panel id. */
	readonly id: string;
	readonly label: string;
	readonly glyph: "chat" | "plugins" | "skills" | "settings";
	readonly active: boolean;
}

export interface PanelOption {
	readonly value: string;
	readonly label: string;
}

/** One editable control on a row. Changing it reports its action id with `data` and the new value. */
export interface PanelControl {
	readonly id: string;
	readonly kind: "switch" | "select" | "number" | "text";
	readonly value: string;
	/** The identifier the action belongs to: a setting field, a target name, a path. */
	readonly data?: string;
	readonly options?: readonly PanelOption[];
	readonly placeholder?: string;
	readonly min?: number;
	readonly step?: number;
	readonly disabled?: boolean;
}

export interface PanelButton {
	readonly id: string;
	readonly label: string;
	readonly tone: "default" | "primary" | "danger";
	readonly data?: string;
	readonly disabled?: boolean;
}

export interface PanelRow {
	/** Stable key for the row across renders. */
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly badges?: readonly string[];
	/** A trailing value line, for a path or a settings key. */
	readonly value?: string;
	readonly controls?: readonly PanelControl[];
	readonly actions?: readonly PanelButton[];
}

export interface PanelGroup {
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	/** Buttons in the group header, such as New or Add. */
	readonly actions?: readonly PanelButton[];
	readonly rows: readonly PanelRow[];
	/** The line shown instead of rows when the group has none. */
	readonly empty?: string;
	/** One line under the rows, for where a change lands and when it applies. */
	readonly footnote?: string;
}

export interface PanelNotice {
	readonly tone: "info" | "error";
	readonly text: string;
}

export interface PanelSpec {
	readonly id: PanelId;
	readonly title: string;
	readonly description?: string;
	readonly notices: readonly PanelNotice[];
	readonly groups: readonly PanelGroup[];
}

export interface PanelField {
	readonly id: string;
	readonly label: string;
	readonly kind: "text" | "textarea";
	readonly value: string;
	readonly placeholder?: string;
}

export interface PanelModal {
	/** The action id a submit reports. */
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly fields: readonly PanelField[];
	readonly submit: string;
	/** The subject of the modal: the name or path a submit acts on. */
	readonly data?: string;
	/** A destructive submit, such as a remove confirmation. */
	readonly danger?: boolean;
}

export interface PanelView {
	readonly nav: readonly NavItem[];
	/** The view the main area shows: "chat" or a panel id. */
	readonly current: string;
	readonly panel?: PanelSpec;
	readonly modal?: PanelModal;
}

/** What the renderer reports back; the page turns each report into a host call. */
export type PanelAction =
	| { readonly kind: "open"; readonly panel: string }
	| { readonly kind: "control"; readonly id: string; readonly data: string | undefined; readonly value: string }
	| { readonly kind: "command"; readonly id: string; readonly data: string | undefined }
	| {
			readonly kind: "modal-submit";
			readonly id: string;
			readonly data: string | undefined;
			readonly fields: Readonly<Record<string, string>>;
	  }
	| { readonly kind: "modal-close" };

/** The view id of the conversation, and the four navigation rows. */
export const CHAT_VIEW = "chat";
export const SETTINGS_VIEW = "settings";

const NAV_ITEMS: readonly { readonly id: string; readonly label: string; readonly glyph: NavItem["glyph"] }[] = [
	{ id: "plugins", label: "Plugins", glyph: "plugins" },
	{ id: "skills", label: "Skills", glyph: "skills" },
	{ id: SETTINGS_VIEW, label: "Settings", glyph: "settings" },
];

/** The sidebar's panel rows and the settings entry, marked with the view the page shows. */
export function panelNav(current: string): NavItem[] {
	return NAV_ITEMS.map((item) => ({ ...item, active: current === item.id }));
}

/** Settings panel input: the host's descriptor catalogue and where it writes. */
export interface SettingDescriptorLike {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly group: string;
	readonly kind: "boolean" | "enum" | "number" | "string";
	readonly options?: readonly PanelOption[];
	readonly min?: number;
	readonly step?: number;
	readonly placeholder?: string;
	readonly field: string;
	readonly explicit: boolean;
	readonly value: string;
}

export interface SettingsStateLike {
	readonly paths: { readonly global: string; readonly project?: string };
	readonly projectTrusted: boolean;
	readonly descriptors: readonly SettingDescriptorLike[];
	readonly errors: readonly {
		readonly scope: string;
		readonly path?: string;
		readonly message: string;
	}[];
}

export interface SkillsStateLike {
	readonly directory: string;
	readonly skills: readonly {
		readonly name: string;
		readonly description: string;
		readonly filePath: string;
		readonly scope: string;
		readonly disableModelInvocation: boolean;
		readonly editable: boolean;
	}[];
	readonly diagnostics: readonly { readonly message: string; readonly path?: string }[];
}

export interface McpServerLike {
	readonly name: string;
	readonly detail: string;
	readonly scope: string;
	readonly enabled: boolean;
	readonly exposure: string;
	readonly editable: boolean;
}

export interface PluginsStateLike {
	readonly packages: readonly string[];
	readonly mcp: {
		readonly servers: readonly McpServerLike[];
		readonly errors: readonly string[];
		readonly globalPath: string;
		readonly projectPath?: string;
	};
}

export interface SettingsPanelInput {
	readonly state: SettingsStateLike | undefined;
}

export interface SkillsPanelInput {
	readonly state: SkillsStateLike | undefined;
}

export interface PluginsPanelInput {
	readonly state: PluginsStateLike | undefined;
}

export interface PanelViewInput {
	/** The view the main area shows; defaults to the conversation. */
	readonly current?: string;
	readonly modal?: PanelModal;
	readonly settings?: SettingsPanelInput;
	readonly skills?: SkillsPanelInput;
	readonly plugins?: PluginsPanelInput;
}

/** The line a panel shows while its service is not bound. */
export const PANEL_UNAVAILABLE = "The host did not offer this service.";

/** The exposure names the MCP configuration accepts, with their labels. */
export const MCP_EXPOSURES: readonly PanelOption[] = [
	{ value: "codemode", label: "Codemode" },
	{ value: "deferred", label: "Deferred" },
	{ value: "direct", label: "Direct" },
	{ value: "hidden", label: "Hidden" },
];

export const SETTINGS_FIELD_ACTION = "settings:set";
export const SETTINGS_RELOAD_ACTION = "settings:reload";
export const SKILL_NEW_ACTION = "skills:new";
export const SKILL_EDIT_ACTION = "skills:edit";
export const SKILL_REMOVE_ACTION = "skills:remove";
export const SKILL_IMPORT_ACTION = "skills:import";
export const SKILL_CREATE_MODAL = "skills:create";
export const SKILL_EDIT_MODAL = "skills:edit";
export const SKILL_VIEW_MODAL = "skills:view";
export const SKILL_REMOVE_MODAL = "skills:remove-confirm";
export const SKILL_IMPORT_MODAL = "skills:import-path";
export const PLUGIN_PACKAGE_ADD_ACTION = "plugins:package-add";
export const PLUGIN_PACKAGE_REMOVE_ACTION = "plugins:package-remove";
export const PLUGIN_MCP_ADD_ACTION = "plugins:mcp-add";
export const PLUGIN_MCP_REMOVE_ACTION = "plugins:mcp-remove";
export const PLUGIN_MCP_ENABLED_ACTION = "plugins:mcp-enabled";
export const PLUGIN_MCP_EXPOSURE_ACTION = "plugins:mcp-exposure";
export const PLUGIN_PACKAGE_MODAL = "plugins:package-path";
export const PLUGIN_MCP_MODAL = "plugins:mcp-entry";

function settingsControls(descriptor: SettingDescriptorLike): PanelControl[] {
	const base = { id: SETTINGS_FIELD_ACTION, data: descriptor.id, value: descriptor.value };
	switch (descriptor.kind) {
		case "boolean":
			return [{ ...base, kind: "switch" }];
		case "enum":
			return [{ ...base, kind: "select", options: descriptor.options ?? [] }];
		case "number":
			return [
				{
					...base,
					kind: "number",
					...(descriptor.min === undefined ? {} : { min: descriptor.min }),
					...(descriptor.step === undefined ? {} : { step: descriptor.step }),
				},
			];
		case "string":
			return [
				{
					...base,
					kind: "text",
					...(descriptor.placeholder === undefined ? {} : { placeholder: descriptor.placeholder }),
				},
			];
	}
}

function unavailablePanel(id: PanelId, title: string, description: string): PanelSpec {
	return {
		id,
		title,
		description,
		notices: [{ tone: "info", text: PANEL_UNAVAILABLE }],
		groups: [],
	};
}

/**
 * The settings panel: the host's catalogue under its own headings, then the files it reads. A row's
 * value line is the settings key, so the file stays discoverable from the panel.
 */
export function settingsPanel(input: SettingsPanelInput): PanelSpec {
	const state = input.state;
	if (state === undefined) {
		return unavailablePanel("settings", "Settings", "The agent's settings files.");
	}
	const groups: PanelGroup[] = [];
	const rowsByGroup = new Map<string, PanelRow[]>();
	for (const descriptor of state.descriptors) {
		const rows = rowsByGroup.get(descriptor.group) ?? [];
		if (!rowsByGroup.has(descriptor.group)) rowsByGroup.set(descriptor.group, rows);
		rows.push({
			id: `setting:${descriptor.id}`,
			title: descriptor.label,
			description: descriptor.description,
			...(descriptor.explicit ? {} : { badges: ["default"] }),
			value: descriptor.field,
			controls: settingsControls(descriptor),
		});
	}
	for (const [group, rows] of rowsByGroup) {
		groups.push({ id: `settings:${group}`, title: group, rows });
	}
	groups.push({
		id: "settings:files",
		title: "Files",
		description: "Where the values above are read from and written to.",
		actions: [{ id: SETTINGS_RELOAD_ACTION, label: "Re-read files", tone: "default" }],
		rows: [
			{ id: "settings:global-path", title: "Global settings", value: state.paths.global },
			{
				id: "settings:project-path",
				title: "Project settings",
				...(state.paths.project === undefined
					? { description: "The project is not trusted, so its settings are not read." }
					: { value: state.paths.project }),
			},
		],
		footnote: "A write goes to the global settings file. Other processes pick it up at their next start.",
	});
	return {
		id: "settings",
		title: "Settings",
		description: "The agent's settings: provider behaviour, reasoning, tools, and the shell.",
		notices: state.errors.map((error) => ({
			tone: "error" as const,
			text: `${error.scope} settings${error.path === undefined ? "" : ` (${error.path})`}: ${error.message}`,
		})),
		groups,
	};
}

/** The skills panel: what the agent loads, and the editing surface for the agent directory's own. */
export function skillsPanel(input: SkillsPanelInput): PanelSpec {
	const state = input.state;
	if (state === undefined) {
		return unavailablePanel("skills", "Skills", "Instructions the agent loads for a matching task.");
	}
	return {
		id: "skills",
		title: "Skills",
		description: "One folder per skill, each with a SKILL.md that carries a name and a description.",
		notices: state.diagnostics.map((diagnostic) => ({
			tone: "error" as const,
			text: `${diagnostic.path === undefined ? "" : `${diagnostic.path}: `}${diagnostic.message}`,
		})),
		groups: [
			{
				id: "skills:list",
				title: "Loaded skills",
				actions: [
					{ id: SKILL_NEW_ACTION, label: "New skill", tone: "primary" },
					{ id: SKILL_IMPORT_ACTION, label: "Import…", tone: "default" },
				],
				rows: state.skills.map((skill) => ({
					id: `skill:${skill.name}`,
					title: skill.name,
					description: skill.description,
					badges: [skill.scope, ...(skill.disableModelInvocation ? ["command only"] : [])],
					value: skill.filePath,
					actions: [
						{
							id: SKILL_EDIT_ACTION,
							label: skill.editable ? "Edit" : "View",
							data: skill.name,
							tone: "default",
						},
						...(skill.editable
							? [{ id: SKILL_REMOVE_ACTION, label: "Remove", data: skill.name, tone: "danger" as const }]
							: []),
					],
				})),
				empty: "No skills yet. New skills live in the agent directory and load when a session starts.",
				footnote: `New and edited skills are written to ${state.directory}. The agent loads skills when a session starts, like the CLI.`,
			},
		],
	};
}

/** The plugins panel: the plugin packages a session loads, and the MCP configuration files. */
export function pluginsPanel(input: PluginsPanelInput): PanelSpec {
	const state = input.state;
	if (state === undefined) {
		return unavailablePanel("plugins", "Plugins", "Plugin packages and MCP servers.");
	}
	return {
		id: "plugins",
		title: "Plugins",
		description: "Plugin packages the host builds, and the MCP servers the coding agent's tools read.",
		notices: state.mcp.errors.map((error) => ({ tone: "error" as const, text: error })),
		groups: [
			{
				id: "plugins:packages",
				title: "Plugin packages",
				description: "A package is built into the Session's facet generation when a worker starts.",
				actions: [{ id: PLUGIN_PACKAGE_ADD_ACTION, label: "Add package…", tone: "primary" }],
				rows: state.packages.map((path) => ({
					id: `package:${path}`,
					title: path,
					actions: [{ id: PLUGIN_PACKAGE_REMOVE_ACTION, label: "Remove", data: path, tone: "danger" }],
				})),
				empty: "No plugin packages: sessions load the built-in facets only.",
				footnote:
					"The server default applies to sessions opened after the change. A running session keeps the generation it started with.",
			},
			{
				id: "plugins:mcp",
				title: "MCP servers",
				description: "Servers the coding agent's MCP extension connects, from mcp.json.",
				actions: [{ id: PLUGIN_MCP_ADD_ACTION, label: "Add server…", tone: "primary" }],
				rows: state.mcp.servers.map((server) => ({
					id: `mcp:${server.name}`,
					title: server.name,
					description: server.detail,
					badges: [server.scope, server.exposure],
					...(server.editable
						? {
								controls: [
									{
										id: PLUGIN_MCP_ENABLED_ACTION,
										kind: "switch" as const,
										data: server.name,
										value: String(server.enabled),
									},
									{
										id: PLUGIN_MCP_EXPOSURE_ACTION,
										kind: "select" as const,
										data: server.name,
										value: server.exposure,
										options: MCP_EXPOSURES,
									},
								],
							}
						: {}),
					actions: [
						{
							id: PLUGIN_MCP_REMOVE_ACTION,
							label: server.editable ? "Remove" : "From extension",
							data: server.name,
							tone: server.editable ? ("danger" as const) : ("default" as const),
							...(server.editable ? {} : { disabled: true }),
						},
					],
				})),
				empty: `No MCP servers configured in ${state.mcp.globalPath}.`,
				footnote:
					"These entries are read by the CLI and the TUI; the experimental web host does not connect MCP servers yet.",
			},
		],
	};
}

/** The panel the main area shows, or undefined for the conversation. */
export function panelSpec(input: PanelViewInput): PanelSpec | undefined {
	switch (input.current ?? CHAT_VIEW) {
		case "settings":
			return settingsPanel(input.settings ?? { state: undefined });
		case "skills":
			return skillsPanel(input.skills ?? { state: undefined });
		case "plugins":
			return pluginsPanel(input.plugins ?? { state: undefined });
		default:
			return undefined;
	}
}

export function panelView(input: PanelViewInput): PanelView {
	const spec = panelSpec(input);
	const current = input.current ?? CHAT_VIEW;
	return {
		nav: panelNav(current),
		current: spec === undefined ? CHAT_VIEW : current,
		...(spec === undefined ? {} : { panel: spec }),
		...(input.modal === undefined ? {} : { modal: input.modal }),
	};
}

/** The modal a skill's create action opens. */
export function newSkillModal(): PanelModal {
	return {
		id: SKILL_CREATE_MODAL,
		title: "New skill",
		description: "The description decides when the agent loads the skill.",
		fields: [
			{ id: "name", label: "Name", kind: "text", value: "", placeholder: "weekly-report" },
			{ id: "description", label: "Description", kind: "text", value: "", placeholder: "When to use this skill" },
			{ id: "body", label: "Instructions", kind: "textarea", value: "" },
		],
		submit: "Create",
	};
}

/** The modal a skill opens: the file itself, so editing loses nothing the loader reads. */
export function skillModal(name: string, content: string, editable: boolean): PanelModal {
	return {
		id: editable ? SKILL_EDIT_MODAL : SKILL_VIEW_MODAL,
		title: editable ? `Edit ${name}` : name,
		description: editable
			? "The whole SKILL.md. The frontmatter must keep the skill's name and a description."
			: "This skill lives outside the agent directory, so it is read-only here.",
		fields: [{ id: "content", label: "SKILL.md", kind: "textarea", value: content }],
		submit: editable ? "Save" : "Close",
		data: name,
	};
}

/** The confirmation a skill's remove action opens. */
export function removeSkillModal(name: string): PanelModal {
	return {
		id: SKILL_REMOVE_MODAL,
		title: `Remove ${name}?`,
		description: "The skill's folder is deleted from the agent directory.",
		fields: [],
		submit: "Remove",
		data: name,
		danger: true,
	};
}

export function importSkillModal(): PanelModal {
	return {
		id: SKILL_IMPORT_MODAL,
		title: "Import a skill",
		description: "Copies a skill folder or markdown file into the agent's skills directory.",
		fields: [{ id: "path", label: "Path", kind: "text", value: "", placeholder: "~/skills/weekly-report" }],
		submit: "Import",
	};
}

export function addPackageModal(): PanelModal {
	return {
		id: PLUGIN_PACKAGE_MODAL,
		title: "Add a plugin package",
		description: "An absolute path to a package with src/session.ts, built when a session starts.",
		fields: [{ id: "path", label: "Package path", kind: "text", value: "", placeholder: "/path/to/plugin" }],
		submit: "Add",
	};
}

export function addMcpServerModal(): PanelModal {
	return {
		id: PLUGIN_MCP_MODAL,
		title: "Add an MCP server",
		description: "The server entry as JSON: a command for stdio, or a url for HTTP.",
		fields: [
			{ id: "name", label: "Name", kind: "text", value: "", placeholder: "filesystem" },
			{
				id: "entry",
				label: "Entry",
				kind: "textarea",
				value: '{\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n}',
			},
		],
		submit: "Add",
	};
}

/** The SKILL.md a create submits: the frontmatter the loader requires, then the instructions. */
export function composeSkill(name: string, description: string, body: string): string {
	const trimmedBody = body.trim();
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n${trimmedBody.length === 0 ? "" : `${trimmedBody}\n`}`;
}
