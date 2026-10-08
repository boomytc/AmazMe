/**
 * The management surface's view model: the sidebar's navigation plus one panel description per
 * management area. A panel is described as groups of rows — a title, an optional value, controls,
 * and buttons — so the renderer needs no feature knowledge and a management area added later is
 * another pure builder here.
 *
 * A builder takes the reader's language and turns the host's identities into prose: the settings
 * catalogue publishes field ids, heading tokens, and stored enum values, and `strings.ts` names
 * them. Copy therefore has one home, and the host never ships a sentence.
 */
import {
	COMPACT_MODAL,
	SCHEDULE_ADD_ACTION,
	SCHEDULE_ADD_MODAL,
	SCHEDULE_ENABLED_ACTION,
	SCHEDULE_REMOVE_ACTION,
	SCHEDULE_REMOVE_MODAL,
	SCHEDULE_RUN_ACTION,
	SESSION_REMOVE_MODAL,
	SESSION_RENAME_MODAL,
} from "./actions.ts";
import type { Locale } from "./locale.ts";
import {
	mcpExposureCopy,
	mcpScopeCopy,
	scheduleCadenceCopy,
	scheduleDueCopy,
	settingFieldCopy,
	settingGroupCopy,
	settingOptionCopy,
	settingScopeCopy,
	skillScopeCopy,
	thinkingLevelCopy,
	translate,
} from "./strings.ts";

/** The main area's views: the conversation, or one management panel. */
export type PanelId = "plugins" | "skills" | "automation" | "settings";

export interface NavItem {
	/** "chat" or a panel id. */
	readonly id: string;
	readonly label: string;
	readonly glyph: "chat" | "plugins" | "skills" | "automation" | "settings";
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

/** A scrollable text block a panel shows: a file's content, or a terminal's output. */
export interface PanelText {
	readonly id: string;
	readonly title?: string;
	/** The line shown in place of the text when there is none. */
	readonly empty?: string;
	readonly text: string;
}

/** A one-line input a panel needs, such as the terminal's command line. */
export interface PanelInput {
	readonly id: string;
	readonly placeholder: string;
	readonly value: string;
	/** The control that submits the line; its id is the action the page receives. */
	readonly submit: PanelButton;
}

export interface PanelSpec {
	/** The panel's own id; the management views use `PanelId`, the dock uses its tabs. */
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly notices: readonly PanelNotice[];
	readonly groups: readonly PanelGroup[];
	/** The action whose call is in flight, so its own control reports itself busy. */
	readonly pending?: PanelPending;
	/** Input lines the panel offers, above its groups. */
	readonly inputs?: readonly PanelInput[];
	/** Text blocks the panel shows, below its groups. */
	readonly texts?: readonly PanelText[];
}

export interface PanelField {
	readonly id: string;
	readonly label: string;
	readonly kind: "text" | "textarea";
	readonly value: string;
	readonly placeholder?: string;
}

/** The control whose host call is in flight: the action id, and the subject it acts on. */
export interface PanelPending {
	readonly id: string;
	readonly data?: string;
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
	/** Whether the submit's call is in flight: the submit is disabled until it settles. */
	readonly pending?: boolean;
	/** What the last submit said; a refused input is reported here, inside the modal. */
	readonly notice?: PanelNotice;
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

/** The view id of the conversation, and the three management rows. */
export const CHAT_VIEW = "chat";
export const SETTINGS_VIEW = "settings";
export const AUTOMATION_VIEW = "automation";

const NAV_ITEMS: readonly { readonly id: string; readonly message: Parameters<typeof translate>[1]; readonly glyph: NavItem["glyph"] }[] =
	[
		{ id: "plugins", message: "nav.plugins", glyph: "plugins" },
		{ id: "skills", message: "nav.skills", glyph: "skills" },
		{ id: AUTOMATION_VIEW, message: "nav.automation", glyph: "automation" },
		{ id: SETTINGS_VIEW, message: "nav.settings", glyph: "settings" },
	];

/** The sidebar's panel rows and the settings entry, marked with the view the page shows. */
export function panelNav(locale: Locale, current: string): NavItem[] {
	return NAV_ITEMS.map((item) => ({
		id: item.id,
		label: translate(locale, item.message),
		glyph: item.glyph,
		active: current === item.id,
	}));
}

/** Settings panel input: the host's descriptor catalogue and where it writes. */
export interface SettingDescriptorLike {
	readonly id: string;
	/** The catalogue's heading token; the panel names it. */
	readonly group: string;
	readonly kind: "boolean" | "enum" | "number" | "string";
	/** An enum's stored values, in the host's order. */
	readonly options?: readonly string[];
	readonly min?: number;
	readonly step?: number;
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
	readonly removable?: boolean;
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

export interface McpRuntimeLike {
	readonly disabled: boolean;
	readonly errors: readonly string[];
	readonly servers: readonly {
		readonly name: string;
		readonly state: string;
		readonly tools: number;
		readonly enabled: boolean;
		readonly exposure: string;
		readonly scope: string;
		readonly canLogin: boolean;
		readonly error: string | null;
	}[];
	readonly login: {
		readonly id: string;
		readonly server: string;
		readonly status: string;
		readonly url: string | null;
		readonly error: string | null;
	} | null;
}

export interface PluginsPanelInput {
	readonly state: PluginsStateLike | undefined;
	readonly runtime?: McpRuntimeLike;
}

/** One planned prompt, as the host stores and publishes it. */
export interface ScheduleRecordLike {
	readonly id: string;
	readonly sessionId: string;
	readonly prompt: string;
	readonly everyMs: number;
	readonly enabled: boolean;
	readonly createdAt: number;
	readonly lastRunAt: number | null;
	readonly lastOutcome: string | null;
	readonly nextRunAt: number;
}

export interface SchedulesStateLike {
	/** The file the host keeps the schedules in. */
	readonly path: string;
	readonly tickMs: number;
	readonly schedules: readonly ScheduleRecordLike[];
}

export interface AutomationPanelInput {
	readonly state: SchedulesStateLike | undefined;
	/** The session a new schedule would belong to: the one the page has attached. */
	readonly sessionId?: string;
	/** The reader's clock, so the next-run line is an input rather than a hidden read. */
	readonly now?: number;
}

export interface PanelViewInput {
	/** The reader's language: every label, heading, and sentence the panel shows. */
	readonly locale: Locale;
	/** The view the main area shows; defaults to the conversation. */
	readonly current?: string;
	readonly modal?: PanelModal;
	readonly settings?: SettingsPanelInput;
	readonly skills?: SkillsPanelInput;
	readonly plugins?: PluginsPanelInput;
	readonly automation?: AutomationPanelInput;
	/** The management call the page has in flight, and what it last said. */
	readonly pending?: PanelPending;
	readonly notice?: PanelNotice;
	/** The open modal's own in-flight and notice state. */
	readonly modalPending?: boolean;
	readonly modalNotice?: PanelNotice;
}

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
export const PLUGIN_MCP_RELOAD_ACTION = "plugins:mcp-reload";
export const PLUGIN_MCP_RECONNECT_ACTION = "plugins:mcp-reconnect";
export const PLUGIN_MCP_LOGIN_ACTION = "plugins:mcp-login";
export const PLUGIN_MCP_LOGIN_OPEN_ACTION = "plugins:mcp-login-open";
export const PLUGIN_MCP_LOGIN_REDIRECT_ACTION = "plugins:mcp-login-redirect";
export const PLUGIN_MCP_LOGIN_CANCEL_ACTION = "plugins:mcp-login-cancel";
export const PLUGIN_MCP_LOGIN_MODAL = "plugins:mcp-login-response";
export const PLUGIN_MCP_MODAL = "plugins:mcp-entry";

function settingsControls(locale: Locale, descriptor: SettingDescriptorLike): PanelControl[] {
	const base = { id: SETTINGS_FIELD_ACTION, data: descriptor.id, value: descriptor.value };
	switch (descriptor.kind) {
		case "boolean":
			return [{ ...base, kind: "switch" }];
		case "enum":
			return [
				{
					...base,
					kind: "select",
					options: (descriptor.options ?? []).map((value) => ({
						value,
						// Reasoning levels use the shared effort names; every other enum is per field.
						label:
							descriptor.id === "defaultThinkingLevel"
								? thinkingLevelCopy(locale, value)
								: settingOptionCopy(locale, descriptor.id, value),
					})),
				},
			];
		case "number":
			return [
				{
					...base,
					kind: "number",
					...(descriptor.min === undefined ? {} : { min: descriptor.min }),
					...(descriptor.step === undefined ? {} : { step: descriptor.step }),
				},
			];
		case "string": {
			const placeholder = settingFieldCopy(locale, descriptor.id).placeholder;
			return [{ ...base, kind: "text", ...(placeholder === undefined ? {} : { placeholder }) }];
		}
	}
}

function unavailablePanel(locale: Locale, id: PanelId, title: string, description: string): PanelSpec {
	return {
		id,
		title,
		description,
		notices: [{ tone: "info", text: translate(locale, "panel.unavailable") }],
		groups: [],
	};
}

/** One settings row: the field's name, its explanation, and the control the host's kind implies. */
function settingRow(locale: Locale, descriptor: SettingDescriptorLike): PanelRow {
	const copy = settingFieldCopy(locale, descriptor.id);
	return {
		id: `setting:${descriptor.id}`,
		title: copy.label,
		...(copy.description.length === 0 ? {} : { description: copy.description }),
		...(descriptor.explicit ? {} : { badges: [translate(locale, "panel.settings.badgeDefault")] }),
		value: descriptor.field,
		controls: settingsControls(locale, descriptor),
	};
}

/**
 * The settings panel: the host's catalogue under its own headings, then the files it reads. A row's
 * value line is the settings key, so the file stays discoverable from the panel.
 */
export function settingsPanel(locale: Locale, input: SettingsPanelInput): PanelSpec {
	const { state } = input;
	const title = translate(locale, "panel.settings.title");
	if (state === undefined) {
		return unavailablePanel(locale, "settings", title, translate(locale, "panel.settings.description"));
	}
	const groups: PanelGroup[] = [];
	const rowsByGroup = new Map<string, PanelRow[]>();
	for (const descriptor of state.descriptors) {
		const rows = rowsByGroup.get(descriptor.group) ?? [];
		if (!rowsByGroup.has(descriptor.group)) rowsByGroup.set(descriptor.group, rows);
		rows.push(settingRow(locale, descriptor));
	}
	for (const [group, rows] of rowsByGroup) {
		groups.push({ id: `settings:${group}`, title: settingGroupCopy(locale, group), rows });
	}
	groups.push({
		id: "settings:files",
		title: translate(locale, "panel.settings.filesTitle"),
		description: translate(locale, "panel.settings.filesDescription"),
		actions: [{ id: SETTINGS_RELOAD_ACTION, label: translate(locale, "panel.settings.reload"), tone: "default" }],
		rows: [
			{
				id: "settings:global-path",
				title: translate(locale, "panel.settings.globalPath"),
				value: state.paths.global,
			},
			{
				id: "settings:project-path",
				title: translate(locale, "panel.settings.projectPath"),
				...(state.paths.project === undefined
					? { description: translate(locale, "panel.settings.untrusted") }
					: { value: state.paths.project }),
			},
		],
		footnote: translate(locale, "panel.settings.footnote"),
	});
	return {
		id: "settings",
		title,
		description: translate(locale, "panel.settings.description"),
		notices: state.errors.map((error) => {
			const scope = settingScopeCopy(locale, error.scope);
			return {
				tone: "error" as const,
				text:
					error.path === undefined
						? translate(locale, "panel.settings.noticePlain", { scope, message: error.message })
						: translate(locale, "panel.settings.notice", { scope, path: error.path, message: error.message }),
			};
		}),
		groups,
	};
}

/** The skills panel: what the agent loads, and the editing surface for the agent directory's own. */
export function skillsPanel(locale: Locale, input: SkillsPanelInput): PanelSpec {
	const { state } = input;
	const title = translate(locale, "panel.skills.title");
	if (state === undefined) {
		return unavailablePanel(locale, "skills", title, translate(locale, "panel.skills.description"));
	}
	return {
		id: "skills",
		title,
		description: translate(locale, "panel.skills.description"),
		notices: state.diagnostics.map((diagnostic) => ({
			tone: "error" as const,
			text: `${diagnostic.path === undefined ? "" : `${diagnostic.path}: `}${diagnostic.message}`,
		})),
		groups: [
			{
				id: "skills:list",
				title: translate(locale, "panel.skills.loaded"),
				actions: [
					{ id: SKILL_NEW_ACTION, label: translate(locale, "panel.skills.new"), tone: "primary" },
					{ id: SKILL_IMPORT_ACTION, label: translate(locale, "panel.skills.import"), tone: "default" },
				],
				rows: state.skills.map((skill) => ({
					id: `skill:${skill.name}`,
					title: skill.name,
					description: skill.description,
					badges: [
						skillScopeCopy(locale, skill.scope),
						...(skill.disableModelInvocation ? [translate(locale, "panel.skills.commandOnly")] : []),
					],
					value: skill.filePath,
					actions: [
						{
							id: SKILL_EDIT_ACTION,
							label: translate(locale, skill.editable ? "panel.skills.edit" : "panel.skills.view"),
							data: skill.name,
							tone: "default",
						},
						...(skill.editable
							? [
									{
										id: SKILL_REMOVE_ACTION,
										label: translate(locale, "panel.skills.remove"),
										data: skill.name,
										tone: "danger" as const,
									},
								]
							: []),
					],
				})),
				empty: translate(locale, "panel.skills.empty"),
				footnote: translate(locale, "panel.skills.footnote", { directory: state.directory }),
			},
		],
	};
}

/** The plugins panel: the plugin packages a session loads, and the MCP configuration files. */
export function pluginsPanel(locale: Locale, input: PluginsPanelInput): PanelSpec {
	const { state, runtime } = input;
	const title = translate(locale, "panel.plugins.title");
	if (state === undefined) {
		return unavailablePanel(locale, "plugins", title, translate(locale, "panel.plugins.description"));
	}
	const remove = translate(locale, "panel.plugins.fromExtension");
	const liveServers = new Map(runtime?.servers.map((server) => [server.name, server]));
	const servers: McpServerLike[] = state.mcp.servers.map((server) => {
		const live = liveServers.get(server.name);
		return live
			? {
					...server,
					enabled: live.enabled,
					exposure: live.exposure,
					scope: live.scope,
					removable: server.scope === "global" && live.scope === "global",
				}
			: server;
	});
	for (const live of liveServers.values()) {
		if (!servers.some((server) => server.name === live.name))
			servers.push({ ...live, detail: "", editable: true, removable: false });
	}
	return {
		id: "plugins",
		title,
		description: translate(locale, "panel.plugins.description"),
		notices: [...new Set([...state.mcp.errors, ...(runtime?.errors ?? [])])].map((error) => ({
			tone: "error" as const,
			text: error,
		})),
		groups: [
			{
				id: "plugins:packages",
				title: translate(locale, "panel.plugins.packages"),
				description: translate(locale, "panel.plugins.packagesDescription"),
				actions: [
					{ id: PLUGIN_PACKAGE_ADD_ACTION, label: translate(locale, "panel.plugins.addPackage"), tone: "primary" },
				],
				rows: state.packages.map((path) => ({
					id: `package:${path}`,
					title: path,
					actions: [
						{
							id: PLUGIN_PACKAGE_REMOVE_ACTION,
							label: translate(locale, "panel.plugins.remove"),
							data: path,
							tone: "danger",
						},
					],
				})),
				empty: translate(locale, "panel.plugins.packagesEmpty"),
				footnote: translate(locale, "panel.plugins.packagesFootnote"),
			},
			{
				id: "plugins:mcp",
				title: translate(locale, "panel.plugins.mcp"),
				description: translate(locale, "panel.plugins.mcpDescription"),
				actions: [
					{ id: PLUGIN_MCP_ADD_ACTION, label: translate(locale, "panel.plugins.addServer"), tone: "primary" },
					...(runtime === undefined
						? []
						: [
								{
									id: PLUGIN_MCP_RELOAD_ACTION,
									label: translate(locale, "panel.plugins.reloadMcp"),
									tone: "default" as const,
								},
							]),
				],
				rows: [
					...servers.map((server) => {
						const live = liveServers.get(server.name);
						return {
							id: `mcp:${server.name}`,
							title: server.name,
							description: live?.error ?? server.detail,
							badges: [
								mcpScopeCopy(locale, server.scope),
								mcpExposureCopy(locale, server.exposure),
								...(live
									? [
											translate(locale, "panel.plugins.runtime", {
												state: mcpStatusCopy(locale, live.state),
												tools: String(live.tools),
											}),
										]
									: []),
							],
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
												options: mcpExposures(locale),
											},
										],
									}
								: {}),
							actions: [
								...(live?.enabled
									? [
											{
												id: PLUGIN_MCP_RECONNECT_ACTION,
												label: translate(locale, "panel.plugins.reconnect"),
												data: server.name,
												tone: "default" as const,
											},
										]
									: []),
								...(live?.canLogin
									? [
											{
												id: PLUGIN_MCP_LOGIN_ACTION,
												label: translate(locale, "panel.plugins.login"),
												data: server.name,
												tone: "default" as const,
											},
										]
									: []),
								{
									id: PLUGIN_MCP_REMOVE_ACTION,
									label: server.editable ? translate(locale, "panel.plugins.remove") : remove,
									data: server.name,
									tone: server.editable ? ("danger" as const) : ("default" as const),
									...(server.editable && server.removable !== false ? {} : { disabled: true }),
								},
							],
						};
					}),
					...(runtime?.login
						? [
								{
									id: `mcp-login:${runtime.login.id}`,
									title: translate(locale, "panel.plugins.loginFor", { server: runtime.login.server }),
									description: runtime.login.error ?? mcpStatusCopy(locale, runtime.login.status),
									actions: [
										...(runtime.login.url
											? [
													{
														id: PLUGIN_MCP_LOGIN_OPEN_ACTION,
														label: translate(locale, "panel.plugins.openAuthorization"),
														data: runtime.login.url,
														tone: "primary" as const,
													},
													{
														id: PLUGIN_MCP_LOGIN_REDIRECT_ACTION,
														label: translate(locale, "panel.plugins.pasteRedirect"),
														data: runtime.login.id,
														tone: "default" as const,
													},
												]
											: []),
										...(["preparing", "awaiting", "finishing"].includes(runtime.login.status)
											? [
													{
														id: PLUGIN_MCP_LOGIN_CANCEL_ACTION,
														label: translate(locale, "panel.plugins.cancelLogin"),
														data: runtime.login.id,
														tone: "default" as const,
													},
												]
											: []),
									],
								},
							]
						: []),
				],
				empty: translate(locale, "panel.plugins.mcpEmpty", { path: state.mcp.globalPath }),
				footnote: translate(locale, "panel.plugins.mcpFootnote"),
			},
		],
	};
}

/** One line for a prompt too long to be a row title. */
function summarize(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The automation panel: the prompts the host runs on their own, for the attached session and for
 * every other session on the host. A row carries the cadence, the session it belongs to, when it is
 * next due, and what its last run produced; Add plans one for the attached session.
 */
export function automationPanel(locale: Locale, input: AutomationPanelInput): PanelSpec {
	const { state, sessionId } = input;
	const now = input.now ?? Date.now();
	const title = translate(locale, "panel.automation.title");
	if (state === undefined) {
		return unavailablePanel(locale, AUTOMATION_VIEW, title, translate(locale, "panel.automation.description"));
	}
	return {
		id: AUTOMATION_VIEW,
		title,
		description: translate(locale, "panel.automation.description"),
		notices:
			sessionId === undefined
				? [{ tone: "info" as const, text: translate(locale, "panel.automation.noSession") }]
				: [],
		groups: [
			{
				id: "automation:schedules",
				title: translate(locale, "panel.automation.schedules"),
				actions: [
					{
						id: SCHEDULE_ADD_ACTION,
						label: translate(locale, "panel.automation.add"),
						tone: "primary" as const,
						...(sessionId === undefined ? { disabled: true } : {}),
					},
				],
				rows: state.schedules.map((schedule) => ({
					id: `schedule:${schedule.id}`,
					title: summarize(schedule.prompt, 90),
					description: scheduleCadenceCopy(locale, schedule.everyMs),
					badges: [schedule.sessionId, ...(schedule.enabled ? [] : [translate(locale, "panel.automation.paused")])],
					value: [
						translate(locale, "panel.automation.next", {
							when: scheduleDueCopy(locale, schedule.nextRunAt, now),
						}),
						...(schedule.lastOutcome === null ? [] : [schedule.lastOutcome]),
					].join(" · "),
					controls: [
						{
							id: SCHEDULE_ENABLED_ACTION,
							kind: "switch" as const,
							data: schedule.id,
							value: String(schedule.enabled),
						},
					],
					actions: [
						{
							id: SCHEDULE_RUN_ACTION,
							label: translate(locale, "panel.automation.run"),
							data: schedule.id,
							tone: "default" as const,
						},
						{
							id: SCHEDULE_REMOVE_ACTION,
							label: translate(locale, "panel.automation.remove"),
							data: schedule.id,
							tone: "danger" as const,
						},
					],
				})),
				empty: translate(locale, "panel.automation.empty"),
				footnote: translate(locale, "panel.automation.footnote", { path: state.path }),
			},
		],
	};
}

function mcpStatusCopy(locale: Locale, state: string): string {
	const labels: Record<string, readonly [string, string]> = {
		connecting: ["连接中", "Connecting"],
		connected: ["已连接", "Connected"],
		disconnected: ["已断开", "Disconnected"],
		disabled: ["已禁用", "Disabled"],
		"needs-auth": ["需要登录", "Sign-in required"],
		failed: ["连接失败", "Failed"],
		closed: ["已关闭", "Closed"],
		preparing: ["准备登录", "Preparing sign-in"],
		awaiting: ["等待授权", "Awaiting authorization"],
		finishing: ["完成登录中", "Finishing sign-in"],
		done: ["登录完成", "Signed in"],
		cancelled: ["已取消", "Cancelled"],
		error: ["登录失败", "Sign-in failed"],
	};
	return labels[state]?.[locale === "zh" ? 0 : 1] ?? state;
}

/** The exposure names the MCP configuration accepts, with the reader's names for them. */
export function mcpExposures(locale: Locale): PanelOption[] {
	return ["codemode", "deferred", "direct", "hidden"].map((value) => ({
		value,
		label: mcpExposureCopy(locale, value),
	}));
}

/** The panel the main area shows, or undefined for the conversation. */
export function panelSpec(input: PanelViewInput): PanelSpec | undefined {
	switch (input.current ?? CHAT_VIEW) {
		case "settings":
			return settingsPanel(input.locale, input.settings ?? { state: undefined });
		case "skills":
			return skillsPanel(input.locale, input.skills ?? { state: undefined });
		case "plugins":
			return pluginsPanel(input.locale, input.plugins ?? { state: undefined });
		case AUTOMATION_VIEW:
			return automationPanel(input.locale, input.automation ?? { state: undefined });
		default:
			return undefined;
	}
}

export function panelView(input: PanelViewInput): PanelView {
	const spec = panelSpec(input);
	const current = input.current ?? CHAT_VIEW;
	// The page's own in-flight action and message ride on the panel it belongs to, so the renderer
	// reads one description of the panel and never looks for feature state of its own.
	const withState =
		spec === undefined
			? undefined
			: {
					...spec,
					...(input.pending === undefined ? {} : { pending: input.pending }),
					notices: input.notice === undefined ? spec.notices : [input.notice, ...spec.notices],
				};
	const modal =
		input.modal === undefined
			? undefined
			: {
					...input.modal,
					...(input.modalPending === undefined ? {} : { pending: input.modalPending }),
					...(input.modalNotice === undefined ? {} : { notice: input.modalNotice }),
				};
	return {
		nav: panelNav(input.locale, current),
		current: spec === undefined ? CHAT_VIEW : current,
		...(withState === undefined ? {} : { panel: withState }),
		...(modal === undefined ? {} : { modal }),
	};
}

/** The modal a skill's create action opens. */
export function newSkillModal(locale: Locale): PanelModal {
	return {
		id: SKILL_CREATE_MODAL,
		title: translate(locale, "modal.skillNew.title"),
		description: translate(locale, "modal.skillNew.description"),
		fields: [
			{
				id: "name",
				label: translate(locale, "modal.skillNew.name"),
				kind: "text",
				value: "",
				placeholder: translate(locale, "modal.skillNew.namePlaceholder"),
			},
			{
				id: "description",
				label: translate(locale, "modal.skillNew.descriptionLabel"),
				kind: "text",
				value: "",
				placeholder: translate(locale, "modal.skillNew.descriptionPlaceholder"),
			},
			{
				id: "body",
				label: translate(locale, "modal.skillNew.body"),
				kind: "textarea",
				value: "",
			},
		],
		submit: translate(locale, "modal.create"),
	};
}

/** The modal a skill opens: the file itself, so editing loses nothing the loader reads. */
export function skillModal(locale: Locale, name: string, content: string, editable: boolean): PanelModal {
	return {
		id: editable ? SKILL_EDIT_MODAL : SKILL_VIEW_MODAL,
		title: editable ? translate(locale, "modal.skillEdit.title", { name }) : name,
		description: translate(locale, editable ? "modal.skillEdit.description" : "modal.skillView.description"),
		fields: [
			{ id: "content", label: translate(locale, "modal.skillFile"), kind: "textarea", value: content },
		],
		submit: translate(locale, editable ? "modal.save" : "modal.close"),
		data: name,
	};
}

/** The confirmation a skill's remove action opens. */
export function removeSkillModal(locale: Locale, name: string): PanelModal {
	return {
		id: SKILL_REMOVE_MODAL,
		title: translate(locale, "modal.skillRemove.title", { name }),
		description: translate(locale, "modal.skillRemove.description"),
		fields: [],
		submit: translate(locale, "panel.skills.remove"),
		data: name,
		danger: true,
	};
}

export function renameSessionModal(locale: Locale, sessionId: string, name: string): PanelModal {
	return {
		id: SESSION_RENAME_MODAL,
		title: translate(locale, "modal.sessionRename.title"),
		fields: [{ id: "name", label: translate(locale, "modal.sessionRename.name"), kind: "text", value: name }],
		submit: translate(locale, "modal.save"),
		data: sessionId,
	};
}

/** The confirmation a session's remove control opens; the page sends its id with the submit. */
export function removeSessionModal(locale: Locale, sessionId: string): PanelModal {
	return {
		id: SESSION_REMOVE_MODAL,
		title: translate(locale, "modal.sessionRemove.title", { id: sessionId }),
		description: translate(locale, "modal.sessionRemove.description"),
		fields: [],
		submit: translate(locale, "modal.sessionRemove.submit"),
		data: sessionId,
		danger: true,
	};
}

/**
 * The modal the header's compaction control opens. Instructions are optional: an empty field asks
 * the host for its own summary, exactly as the CLI's `/compact` does.
 */
export function compactModal(locale: Locale): PanelModal {
	return {
		id: COMPACT_MODAL,
		title: translate(locale, "modal.compact.title"),
		description: translate(locale, "modal.compact.description"),
		fields: [
			{
				id: "instructions",
				label: translate(locale, "modal.compact.instructions"),
				kind: "textarea",
				value: "",
				placeholder: translate(locale, "modal.compact.placeholder"),
			},
		],
		submit: translate(locale, "modal.compact.submit"),
	};
}

export function importSkillModal(locale: Locale): PanelModal {
	return {
		id: SKILL_IMPORT_MODAL,
		title: translate(locale, "modal.import.title"),
		description: translate(locale, "modal.import.description"),
		fields: [
			{
				id: "path",
				label: translate(locale, "modal.import.path"),
				kind: "text",
				value: "",
				placeholder: translate(locale, "modal.import.pathPlaceholder"),
			},
		],
		submit: translate(locale, "modal.import.submit"),
	};
}

export function addPackageModal(locale: Locale): PanelModal {
	return {
		id: PLUGIN_PACKAGE_MODAL,
		title: translate(locale, "modal.package.title"),
		description: translate(locale, "modal.package.description"),
		fields: [
			{
				id: "path",
				label: translate(locale, "modal.package.path"),
				kind: "text",
				value: "",
				placeholder: translate(locale, "modal.package.pathPlaceholder"),
			},
		],
		submit: translate(locale, "modal.add"),
	};
}

export function addMcpServerModal(locale: Locale): PanelModal {
	return {
		id: PLUGIN_MCP_MODAL,
		title: translate(locale, "modal.mcp.title"),
		description: translate(locale, "modal.mcp.description"),
		fields: [
			{
				id: "name",
				label: translate(locale, "modal.mcp.name"),
				kind: "text",
				value: "",
				placeholder: translate(locale, "modal.mcp.namePlaceholder"),
			},
			{
				id: "entry",
				label: translate(locale, "modal.mcp.entry"),
				kind: "textarea",
				value: '{\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n}',
			},
		],
		submit: translate(locale, "modal.add"),
	};
}

/**
 * The modal a plan-a-prompt action opens: the text the host will send, and the gap between runs.
 */
export function addScheduleModal(locale: Locale, sessionId: string): PanelModal {
	return {
		id: SCHEDULE_ADD_MODAL,
		title: translate(locale, "modal.scheduleAdd.title"),
		description: translate(locale, "modal.scheduleAdd.description", { session: sessionId }),
		fields: [
			{
				id: "prompt",
				label: translate(locale, "modal.scheduleAdd.prompt"),
				kind: "textarea",
				value: "",
				placeholder: translate(locale, "modal.scheduleAdd.promptPlaceholder"),
			},
			{
				id: "everyMinutes",
				label: translate(locale, "modal.scheduleAdd.every"),
				kind: "text",
				value: "15",
			},
		],
		submit: translate(locale, "modal.scheduleAdd.submit"),
	};
}

/** The confirmation a schedule's remove control opens; its id is what a submit acts on. */
export function removeScheduleModal(locale: Locale, id: string): PanelModal {
	return {
		id: SCHEDULE_REMOVE_MODAL,
		title: translate(locale, "modal.scheduleRemove.title"),
		description: translate(locale, "modal.scheduleRemove.description"),
		fields: [],
		submit: translate(locale, "modal.scheduleRemove.submit"),
		data: id,
		danger: true,
	};
}

/** The SKILL.md a create submits: the frontmatter the loader requires, then the instructions. */
export function composeSkill(name: string, description: string, body: string): string {
	const trimmedBody = body.trim();
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n${trimmedBody.length === 0 ? "" : `${trimmedBody}\n`}`;
}
