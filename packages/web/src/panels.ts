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
	MODEL_SCOPE_ACTION,
	REFRESH_MODELS_ACTION,
	MODEL_SELECT_ACTION,
	MODEL_THINKING_ACTION,
	MODEL_DEFAULTS_ACTION,
	MODEL_CONNECTIONS_ACTION,
	SESSION_RELOAD_ACTION,
	SCHEDULE_ADD_ACTION,
	SCHEDULE_ADD_MODAL,
	SCHEDULE_ENABLED_ACTION,
	SCHEDULE_REMOVE_ACTION,
	SCHEDULE_REMOVE_MODAL,
	SCHEDULE_RUN_ACTION,
	SCHEDULE_EDIT_ACTION,
	SCHEDULE_HISTORY_ACTION,
	SCHEDULE_HISTORY_MODAL,
	SCHEDULE_CANCEL_ACTION,
	SCHEDULE_RELOAD_ACTION,
	SESSION_REMOVE_MODAL,
	SESSION_RENAME_MODAL,
} from "./actions.ts";
import type { ModelPicker, SessionDirectoryLike } from "./view.ts";
import { rosterItems } from "./view.ts";
import type { Locale } from "./locale.ts";
import { errorMessageCopy } from "./errors.ts";
import { SESSION_ARCHIVE_OPEN_ACTION, SESSION_RESTORE_ACTION } from "./projects.ts";
import {
	type MessageKey,
	mcpExposureCopy,
	mcpScopeCopy,
	scheduleRuleCopy,
	scheduleOutcomeCopy,
	scheduleDueCopy,
	settingFieldCopy,
	settingGroupCopy,
	settingGroupDescriptionCopy,
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
	readonly group?: string;
	readonly disabled?: boolean;
	readonly value: string;
	readonly label: string;
}

/** One editable control on a row. Changing it reports its action id with `data` and the new value. */
export interface PanelControl {
	readonly id: string;
	readonly label?: string;
	readonly kind: "switch" | "select" | "number" | "text";
	readonly value: string;
	/** The identifier the action belongs to: a setting field, a target name, a path. */
	readonly data?: string;
	readonly options?: readonly PanelOption[];
	readonly placeholder?: string;
	readonly min?: number;
	readonly max?: number;
	readonly step?: number;
	readonly disabled?: boolean;
}

/** One filled button per region. Line is the visible secondary. Text is a quiet row action. */
export type ButtonWeight = "filled" | "line" | "text";

export interface PanelButton {
	readonly id: string;
	readonly label: string;
	readonly weight: ButtonWeight;
	/** Danger is a color on the chosen weight, not a fourth weight. */
	readonly danger?: boolean;
	readonly data?: string;
	readonly disabled?: boolean;
	/** Set on a control that opens and closes the same thing. */
	readonly pressed?: boolean;
	/** A footer action sits on the leading edge; the others stay with cancel and submit. */
	readonly placement?: "start";
}

/** Additions and deletions of one changed file, drawn as a pair rather than a neutral label. */
export interface PanelDelta {
	readonly added: number;
	readonly removed: number;
}

export interface PanelRow {
	/** Stable key for the row across renders. */
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly badges?: readonly (string | PanelDelta)[];
	/** A trailing value line, for a path or a settings key. */
	readonly value?: string;
	readonly controls?: readonly PanelControl[];
	readonly actions?: readonly PanelButton[];
	/** A block shown directly under this row, such as the diff for a changed file. */
	readonly detail?: PanelText;
	/** A compact, whole-row navigation target; never wraps other interactive controls. */
	readonly file?: { readonly kind: "dir" | "file" | "up"; readonly action: PanelButton };
	/** Secondary management actions stay in a keyboard-accessible menu instead of repeating buttons. */
	readonly menu?: {
		readonly label: string;
		readonly data: string;
		readonly actions: readonly (PanelButton & { readonly glyph: "square-pen" | "folder" | "x" })[];
	};
}

export type PanelSkeleton = "form" | "records";

export type EmptyCause = "first-use" | "no-match" | "failed" | "unavailable" | "done";

export interface PanelEmpty {
	readonly cause: EmptyCause;
	readonly text: string;
}

export interface PanelLead {
	readonly title: string;
	readonly description?: string;
	readonly actions: readonly PanelButton[];
}

export interface PanelGroup {
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	/** Buttons in the group header, such as New or Add. */
	readonly actions?: readonly PanelButton[];
	/** A band above the rows, for one task that is not itself a record. */
	readonly lead?: PanelLead;
	readonly skeleton?: PanelSkeleton;
	readonly rows: readonly PanelRow[];
	/** The line shown instead of rows when the group has none. */
	readonly empty?: PanelEmpty;
	/** One line under the rows, for where a change lands and when it applies. */
	readonly footnote?: string;
}

export type NoticePersistence = "transient" | "pinned";

export interface PanelNotice {
	readonly tone: "info" | "error" | "warning";
	readonly text: string;
	/** Info fades. Errors and warnings stay until the text changes. */
	readonly persistence?: NoticePersistence;
	/** The provider verification line: a status dot, then the text. */
	readonly verification?: "checking" | "success" | "error";
}

/** A scrollable text block a panel shows: a file's content, or a terminal's output. */
export interface PanelText {
	readonly id: string;
	readonly title?: string;
	/** The line shown in place of the text when there is none. */
	readonly empty?: string;
	readonly text: string;
	/** Read-only source preview, with line numbers and copy/wrap controls. */
	readonly source?: { readonly startLine: number; readonly selection?: { readonly line: number; readonly revision: number } };
	/** Recorded unified diff, not a proposed edit or ordinary terminal output. */
	readonly diff?: boolean;
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
	/** Page-level actions, shown beside the title. */
	readonly actions?: readonly PanelButton[];
	readonly notices: readonly PanelNotice[];
	readonly groups: readonly PanelGroup[];
	/** The action whose call is in flight, so its own control reports itself busy. */
	readonly pending?: PanelPending;
	/** Input lines the panel offers, above its groups. */
	readonly inputs?: readonly PanelInput[];
	/** Text blocks the panel shows, below its groups. */
	readonly texts?: readonly PanelText[];
	/** File navigation is presentation-only; the host remains authoritative about accessible paths. */
	readonly files?: {
		readonly cwd: string;
		readonly path: string;
		readonly breadcrumbs: readonly { readonly label: string; readonly path: string; readonly current: boolean }[];
		readonly filterScope?: string;
	};
}

export interface PanelField {
	readonly id: string;
	readonly label: string;
	readonly kind: "text" | "textarea" | "select" | "checkbox" | "multiselect" | "directories";
	readonly inputType?: "number" | "datetime-local" | "password";
	readonly options?: readonly { readonly value: string; readonly label: string }[];
	/** Every condition must match. One condition stays a single rule; several are combined. */
	readonly visibleWhen?: { readonly field: string; readonly values: readonly string[] } | readonly { readonly field: string; readonly values: readonly string[] }[];
	readonly readOnly?: boolean;
	readonly description?: string;
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
	readonly submit?: string;
	/** Optional footer actions, reported through the same command path as panel buttons. */
	readonly actions?: readonly PanelButton[];
	/** The dismiss button's label when closing does not cancel the underlying operation. */
	readonly dismiss?: string;
	/** The subject of the modal: the name or path a submit acts on. */
	readonly data?: string;
	/** A destructive submit, such as a remove confirmation. */
	readonly danger?: boolean;
	/** A long edit sits beside the list. A short form or a confirmation stays centered. */
	readonly presentation?: "dialog" | "drawer";
	/** A submit is in flight: fields, actions and dismissal stay locked until it settles. */
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
	readonly settingsSection?: { readonly id: string; readonly generation: number };
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
export function panelNav(locale: Locale, current: string, available?: readonly string[]): NavItem[] {
	return NAV_ITEMS.filter(item => available === undefined || available.includes(item.id)).map((item) => ({
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
	readonly max?: number;
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
	readonly packageDetails?: Readonly<Record<string, { readonly detail: string; readonly canLoad: boolean }>>;
	readonly mcp: {
		readonly servers: readonly McpServerLike[];
		readonly errors: readonly string[];
		readonly globalPath: string;
		readonly projectPath?: string;
	};
}

export interface SettingsPanelInput {
	readonly hostModels?: boolean;
	readonly state: SettingsStateLike | undefined;
	readonly models?: { readonly available: boolean; readonly authentication: boolean; readonly selected: boolean; readonly picker: ModelPicker };
	/** Archived sessions the settings list owns. Absent until the host has published a directory. */
	readonly archives?: {
		readonly sessions: SessionDirectoryLike["sessions"];
		readonly projects: NonNullable<SessionDirectoryLike["projects"]>;
		readonly retentionDays: number;
		readonly now: number;
	};
}

export interface SkillsPanelInput {
	readonly state: SkillsStateLike | undefined;
}

export interface McpRuntimeLike {
	readonly disabled: boolean;
	readonly canConnect?: boolean;
	readonly canOverrideProject: boolean;
	readonly errors: readonly string[];
	readonly servers: readonly {
		readonly name: string;
		readonly detail: string;
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
	/** null means a selected session has no usable MCP binding yet. */
	readonly runtime?: McpRuntimeLike | null;
}

export type ScheduleRuleLike =
	| { readonly kind: "interval"; readonly everyMinutes: number }
	| { readonly kind: "once"; readonly at: string; readonly timeZone: string }
	| { readonly kind: "cron"; readonly expression: string; readonly timeZone: string };

export interface ScheduleRecordLike {
	readonly id: string;
	readonly generation: number;
	readonly target: { readonly kind: "session"; readonly sessionId: string } | { readonly kind: "new_session"; readonly workspace: string; readonly title: string; readonly projectId: string; readonly model: string };
	readonly prompt: string;
	readonly rule: ScheduleRuleLike;
	readonly busy: "queue" | "skip";
	readonly missed: "latest" | "skip";
	readonly graceMinutes: number;
	readonly timeoutSeconds: number;
	readonly enabled: boolean;
	readonly createdAt: number;
	readonly nextRunAt: number | null;
	readonly pending: { readonly sessionId: string; readonly cancelReason: "cancelled" | "timed_out" | null; readonly deadlineAt: number; readonly problem: string | null } | null;
	readonly history: readonly { readonly sessionId: string; readonly startedAt: number; readonly finishedAt: number; readonly scheduledFor: number | null;
		readonly status: "done" | "unanswered" | "refused" | "cancelled" | "timed_out" | "skipped"; readonly detail: string | null }[];
}

export interface SchedulesStateLike {
	readonly problem?: string | null;
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
	/** Management views backed by the connected host's actual service catalogue. */
	readonly availableViews?: readonly string[];
	readonly modal?: PanelModal;
	readonly settingsSection?: PanelView["settingsSection"];
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
export const DIAGNOSTICS_ACTION = "settings:diagnostics";
export const DIAGNOSTICS_MODAL = "settings:diagnostic-report";
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
export const PLUGIN_MCP_PROJECT_ACTION = "plugins:mcp-project";
export const PLUGIN_MCP_PROJECT_MODAL = "plugins:mcp-project-submit";

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
					...(descriptor.max === undefined ? {} : { max: descriptor.max }),
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
		notices: [{ tone: "info", text: translate(locale, "panel.unavailable"), persistence: "pinned" }],
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
	if (input.hostModels) {
		groups.push({ id: "settings:models", title: translate(locale, "connections.title"), description: translate(locale, "connections.help"), rows: [] });
	} else if (input.models !== undefined) {
		const { picker, available, selected: hasSelected } = input.models;
		const selected = picker.groups.flatMap(group => group.options).find(option => option.selected);
		const scopeEmpty = picker.empty === translate(locale, "model.scopeEmpty");
		const placeholderKey = picker.empty === undefined ? "model.choose" : scopeEmpty ? "model.configure" : "model.connectProvider";
		groups.push({
			id: "settings:models", title: translate(locale, "model.manage"),
			description: translate(locale, available ? "model.manageHelp" : "model.needsSession"),
			actions: [
				{ id: REFRESH_MODELS_ACTION, label: picker.refresh.label, weight: "line", disabled: !available || picker.refresh.busy },
				{ id: MODEL_SCOPE_ACTION, label: translate(locale, "model.scope"), weight: "line", disabled: !available },
				{ id: MODEL_CONNECTIONS_ACTION, label: translate(locale, "model.connectProvider"), weight: "line", disabled: !available },
				{ id: MODEL_DEFAULTS_ACTION, label: translate(locale, "model.defaults"), weight: "line", disabled: !available || picker.disabled || !hasSelected },
			], rows: [
				{
					id: "models:selection", title: translate(locale, "model.current"),
					description: picker.scopeNotice ?? picker.empty ?? translate(locale, "model.nextRequest"),
					...(picker.scopeNotice ? { value: picker.label } : {}),
					controls: [{
						id: MODEL_SELECT_ACTION, kind: "select", value: selected ? JSON.stringify([selected.provider, selected.modelId]) : "",
						disabled: !available || picker.disabled || picker.groups.length === 0,
						options: [{ value: "", label: translate(locale, placeholderKey), disabled: true },
							...picker.groups.flatMap(group => group.options.map(option => ({ value: JSON.stringify([option.provider, option.modelId]), label: option.label, group: group.provider })))],
					}],
				},
				...(picker.levels.length <= 1 ? [] : [{
					id: "models:thinking", title: translate(locale, "model.effort"),
					description: translate(locale, "model.supportedLevels"),
					controls: [{ id: MODEL_THINKING_ACTION, kind: "select" as const, value: picker.levels.find(level => level.selected)?.level ?? "", disabled: !available || picker.disabled,
						options: picker.levels.map(level => ({ value: level.level, label: level.label })) }],
				}]),
			], skeleton: "form", footnote: picker.refresh.status,
		});
	}
	const rowsByGroup = new Map<string, PanelRow[]>();
	for (const descriptor of state.descriptors) {
		const rows = rowsByGroup.get(descriptor.group) ?? [];
		if (!rowsByGroup.has(descriptor.group)) rowsByGroup.set(descriptor.group, rows);
		rows.push(settingRow(locale, descriptor));
	}
	for (const [group, rows] of rowsByGroup) {
		groups.push({ id: `settings:${group}`, title: settingGroupCopy(locale, group), description: settingGroupDescriptionCopy(locale, group), skeleton: "form", rows });
	}
	if (input.archives) {
		const archives = input.archives;
		const dueAt = (archivedAt: number): boolean => archives.retentionDays > 0 && archives.now - archivedAt >= archives.retentionDays * 86400000;
		const rows = rosterItems(locale, { sessions: archives.sessions, projects: archives.projects }, undefined, archives.now, "", true, 0).map(item => {
			const session = archives.sessions.find(candidate => candidate.sessionId === item.id);
			const projectName = archives.projects.find(project => project.id === item.projectId)?.name ?? item.cwd ?? "";
			const due = session?.archivedAt !== undefined && dueAt(session.archivedAt);
			return {
				id: `settings:archive:${item.id}`,
				title: item.label,
				...(projectName.length === 0 ? { description: item.age } : { description: `${projectName} · ${item.age}` }),
				...(due ? { badges: [translate(locale, "project.retentionDue")] } : {}),
				actions: [
					{ id: SESSION_ARCHIVE_OPEN_ACTION, label: translate(locale, "panel.settings.archivedSessionsOpen"), weight: "text" as const, data: item.id },
				],
				menu: {
					label: translate(locale, "project.restore"),
					data: item.id,
					actions: [
						{ id: SESSION_RESTORE_ACTION, label: translate(locale, "project.restore"), weight: "text" as const, data: item.id, glyph: "folder" as const },
					],
				},
			};
		});
		groups.push({
			id: "settings:archives", title: translate(locale, "project.archived"),
			description: translate(locale, "panel.settings.archivedSessionsHelp"),
			skeleton: "records",
			rows,
			...(rows.length === 0 ? { empty: { cause: "first-use" as const, text: translate(locale, "panel.settings.archivedGroupEmpty") } } : {}),
			footnote: archives.retentionDays > 0
				? translate(locale, "panel.settings.archivedFootnote", { days: String(archives.retentionDays) })
				: translate(locale, "panel.settings.archivedKeepForever"),
		});
	}
	groups.push({
		id: "settings:files",
		title: translate(locale, "panel.settings.filesTitle"),
		description: translate(locale, "panel.settings.filesDescription"),
		skeleton: "form",
		actions: [
			{ id: SETTINGS_RELOAD_ACTION, label: translate(locale, "panel.settings.reload"), weight: "line" },
			...(input.models === undefined ? [] : [{ id: SESSION_RELOAD_ACTION, label: translate(locale, "page.reloadResources"), weight: "line" as const, disabled: !input.models.available }]),
			{ id: DIAGNOSTICS_ACTION, label: translate(locale, "panel.settings.diagnostics"), weight: "line" },
		],
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
			const message = errorMessageCopy(locale, error.message);
			return {
				tone: "error" as const,
				text:
					error.path === undefined
						? translate(locale, "panel.settings.noticePlain", { scope, message })
						: translate(locale, "panel.settings.notice", { scope, path: error.path, message }),
			};
		}),
		groups,
	};
}

/** One settings search result. A category match has no `rowId`; a setting match names the row to reveal. */
export interface SettingsSearchHit {
	readonly groupId: string;
	readonly rowId?: string;
	readonly label: string;
	/** The category name. A setting result shows it under the setting's own name. */
	readonly panelLabel: string;
}

function visibleText(parts: readonly (string | undefined)[]): string {
	return parts.filter((part) => part !== undefined && part.length > 0).join("\n").toLocaleLowerCase();
}

function matchesTokens(text: string, tokens: readonly string[]): boolean {
	return tokens.every((token) => text.includes(token));
}

function groupSearchText(group: PanelGroup): string {
	return visibleText([
		group.title,
		group.description,
		group.footnote,
		group.empty?.text,
		...(group.actions ?? []).map((action) => action.label),
	]);
}

function rowSearchText(row: PanelRow): string {
	return visibleText([
		row.title,
		row.description,
		row.value,
		...(row.badges ?? []).map((badge) => typeof badge === "string" ? badge : `+${badge.added} −${badge.removed}`),
		...(row.actions ?? []).map((action) => action.label),
		...(row.controls ?? []).flatMap((control) => [
			control.label,
			control.placeholder,
			control.kind === "number" || control.kind === "text" ? control.value : undefined,
			...(control.options ?? []).flatMap((option) => [option.label, option.group]),
		]),
	]);
}

/**
 * Settings the query names, in catalogue order. A blank query matches nothing, so the sidebar keeps
 * its categories. A category matches on its heading and explanation; a setting matches on the text
 * that row shows, including option names. Matching a category does not list every setting inside it.
 */
export function searchSettings(groups: readonly PanelGroup[], query: string): SettingsSearchHit[] {
	const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter((token) => token.length > 0);
	if (tokens.length === 0) return [];
	const hits: SettingsSearchHit[] = [];
	for (const group of groups) {
		if (matchesTokens(groupSearchText(group), tokens)) {
			hits.push({ groupId: group.id, label: group.title, panelLabel: group.title });
		}
		for (const row of group.rows) {
			if (!matchesTokens(rowSearchText(row), tokens)) continue;
			hits.push({ groupId: group.id, rowId: row.id, label: row.title, panelLabel: group.title });
		}
	}
	return hits;
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
				skeleton: "records",
				actions: [
					{ id: SKILL_NEW_ACTION, label: translate(locale, "panel.skills.new"), weight: "filled" },
					{ id: SKILL_IMPORT_ACTION, label: translate(locale, "panel.skills.import"), weight: "line" },
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
							weight: "text" as const,
						},
					],
					...(skill.editable
						? {
								menu: {
									label: translate(locale, "panel.skills.remove"),
									data: skill.name,
									actions: [
										{
											id: SKILL_REMOVE_ACTION,
											label: translate(locale, "panel.skills.remove"),
											data: skill.name,
											weight: "text" as const,
											danger: true,
											glyph: "x" as const,
										},
									],
								},
							}
						: {}),
				})),
				empty: { cause: "first-use", text: translate(locale, "panel.skills.empty") },
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
	const servers: readonly McpServerLike[] = runtime === undefined ? state.mcp.servers
		: (runtime?.servers ?? []).map((live) => ({
			...live,
			editable: true,
			removable: live.scope === "global",
		}));
	return {
		id: "plugins",
		title,
		description: translate(locale, "panel.plugins.description"),
		notices: [...new Set(runtime === undefined ? state.mcp.errors : (runtime?.errors ?? []))].map((error) => ({
			tone: "error" as const,
			text: error,
		})),
		groups: [
			{
				id: "plugins:packages",
				title: translate(locale, "panel.plugins.packages"),
				skeleton: "records",
				description: translate(locale, "panel.plugins.packagesDescription"),
				actions: [
					{ id: PLUGIN_PACKAGE_ADD_ACTION, label: translate(locale, "panel.plugins.addPackage"), weight: "filled" },
				],
				rows: state.packages.map((path) => ({
					id: `package:${path}`,
					title: path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path,
					value: path,
					...(state.packageDetails?.[path] ? { description: state.packageDetails[path].detail } : {}),
					menu: {
						label: translate(locale, "panel.plugins.remove"),
						data: path,
						actions: [
							...(state.packageDetails?.[path]?.canLoad ? [{ id: "plugins:package-reload", label: translate(locale, "panel.settings.reload"), data: path, weight: "text" as const, glyph: "folder" as const }] : []),
							{
								id: PLUGIN_PACKAGE_REMOVE_ACTION,
								label: translate(locale, "panel.plugins.remove"),
								data: path,
								weight: "text",
								danger: true,
								glyph: "x",
							},
						],
					},
				})),
				empty: { cause: "first-use", text: translate(locale, "panel.plugins.packagesEmpty") },
				footnote: translate(locale, "panel.plugins.packagesFootnote"),
			},
			{
				id: "plugins:mcp",
				title: translate(locale, "panel.plugins.mcp"),
				skeleton: "records",
				description: translate(locale, "panel.plugins.mcpDescription"),
				actions: [
					{ id: PLUGIN_MCP_ADD_ACTION, label: translate(locale, "panel.plugins.addServer"), weight: "filled" },
					...(runtime === undefined
						? []
						: [
								{
									id: PLUGIN_MCP_RELOAD_ACTION,
									label: translate(locale, "panel.plugins.reloadMcp"),
									weight: "line" as const,
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
												label: translate(locale, "panel.plugins.enabled"),
												kind: "switch" as const,
												data: server.name,
												value: String(server.enabled),
											},
											{
												id: PLUGIN_MCP_EXPOSURE_ACTION,
												label: translate(locale, "panel.plugins.exposure"),
												kind: "select" as const,
												data: server.name,
												value: server.exposure,
												options: mcpExposures(locale),
											},
										],
									}
								: {}),
							menu: {
								label: translate(locale, "panel.rowActions"),
								data: server.name,
								actions: [
									...(live?.scope === "global" && runtime?.canOverrideProject && server.editable
										? [{ id: PLUGIN_MCP_PROJECT_ACTION, label: translate(locale, "panel.plugins.projectSettings"), data: server.name, weight: "text" as const, glyph: "folder" as const }]
										: []),
									...(live?.enabled
										? [{ id: PLUGIN_MCP_RECONNECT_ACTION, label: translate(locale, "panel.plugins.reconnect"), data: server.name, weight: "text" as const, glyph: "folder" as const, disabled: runtime?.canConnect === false }]
										: []),
									...(live?.canLogin
										? [{ id: PLUGIN_MCP_LOGIN_ACTION, label: translate(locale, "panel.plugins.login"), data: server.name, weight: "text" as const, glyph: "folder" as const }]
										: []),
									{
										id: PLUGIN_MCP_REMOVE_ACTION,
										label: server.editable ? translate(locale, "panel.plugins.remove") : remove,
										data: server.name,
										weight: "text" as const,
										glyph: "x" as const,
										...(server.editable ? { danger: true } : {}),
										...(server.editable && server.removable !== false ? {} : { disabled: true }),
									},
								],
							},
						};
					}),
				],
				...(runtime?.login
					? {
							lead: {
								title: translate(locale, "panel.plugins.loginFor", { server: runtime.login.server }),
								description: runtime.login.error ?? mcpStatusCopy(locale, runtime.login.status),
								actions: [
									...(runtime.login.url
										? [
												{ id: PLUGIN_MCP_LOGIN_OPEN_ACTION, label: translate(locale, "panel.plugins.openAuthorization"), data: runtime.login.url, weight: "filled" as const },
												{ id: PLUGIN_MCP_LOGIN_REDIRECT_ACTION, label: translate(locale, "panel.plugins.pasteRedirect"), data: runtime.login.id, weight: "line" as const },
											]
										: []),
									...(["preparing", "awaiting", "finishing"].includes(runtime.login.status)
										? [{ id: PLUGIN_MCP_LOGIN_CANCEL_ACTION, label: translate(locale, "panel.plugins.cancelLogin"), data: runtime.login.id, weight: "line" as const }]
										: []),
								],
							},
						}
					: {}),
				empty: runtime === null
					? { cause: "unavailable" as const, text: translate(locale, "panel.plugins.mcpUnavailable") }
					: { cause: "first-use" as const, text: translate(locale, "panel.plugins.mcpEmpty", { path: state.mcp.globalPath }) },
				footnote: translate(locale, "panel.plugins.mcpFootnote", { path: state.mcp.globalPath }),
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
	const { state } = input;
	const now = input.now ?? Date.now();
	const title = translate(locale, "panel.automation.title");
	if (state === undefined) {
		return unavailablePanel(locale, AUTOMATION_VIEW, title, translate(locale, "panel.automation.description"));
	}
	return {
		id: AUTOMATION_VIEW,
		title,
		description: translate(locale, "panel.automation.description"),
		notices: [
			...(state.problem ? [{ tone: "error" as const, text: state.problem }] : []),
		],
		groups: [
			{
				id: "automation:schedules",
				title: translate(locale, "panel.automation.schedules"),
				skeleton: "records",
				actions: [
					{
						id: SCHEDULE_ADD_ACTION,
						label: translate(locale, "panel.automation.add"),
						weight: "filled" as const,
						...(state.problem ? { disabled: true } : {}),
					},
					...(state.problem ? [{ id: SCHEDULE_RELOAD_ACTION, label: translate(locale, "panel.settings.reload"), weight: "line" as const }] : []),
				],
				rows: state.schedules.map((schedule) => ({
					id: `schedule:${schedule.id}`,
					title: summarize(schedule.target.kind === "new_session" ? schedule.target.title : schedule.prompt, 90),
					description: [scheduleRuleCopy(locale, schedule.rule), translate(locale, schedule.busy === "queue" ? "panel.automation.busyQueue" : "panel.automation.busySkip"),
						translate(locale, schedule.missed === "latest" ? "panel.automation.missedLatest" : "panel.automation.missedSkip"),
						translate(locale, "panel.automation.timeout", { seconds: String(schedule.timeoutSeconds) })].join(" · "),
					badges: [schedule.target.kind === "session" ? schedule.target.sessionId : translate(locale, "modal.scheduleAdd.newSession"), ...(schedule.nextRunAt === null ? [translate(locale, "panel.automation.finished")] : schedule.enabled ? [] : [translate(locale, "panel.automation.paused")])],
					value: [
						translate(locale, "panel.automation.next", {
							when: scheduleDueCopy(locale, schedule.nextRunAt, now),
						}),
						...(schedule.history.length === 0 ? [] : [scheduleOutcomeCopy(locale, schedule.history.at(-1)!)]),
						...(schedule.pending === null ? [] : [state.problem ? translate(locale, "panel.automation.recoveryPending") : schedule.pending.problem ?? translate(locale, schedule.pending.cancelReason !== null ? "panel.automation.cancelling" : "panel.automation.running")]),
					].join(" · "),
					controls: [
						{
							id: SCHEDULE_ENABLED_ACTION,
							...(state.problem || schedule.nextRunAt === null ? { disabled: true } : {}),
							kind: "switch" as const,
							data: schedule.id,
							value: String(schedule.enabled),
						},
					],
					menu: {
						label: translate(locale, "panel.rowActions"),
						data: schedule.id,
						actions: [
							...(schedule.pending?.sessionId || schedule.history.some(item => item.sessionId) ? [{ id: "schedule:open-session", label: translate(locale, "panel.automation.openResult"), weight: "text" as const, glyph: "folder" as const }] : []),
							{
								id: SCHEDULE_RUN_ACTION,
								...(state.problem || schedule.pending !== null ? { disabled: true } : {}),
								label: translate(locale, "panel.automation.run"),
								data: schedule.id,
								weight: "text" as const,
								glyph: "folder" as const,
							},
							...(schedule.pending === null ? [] : [{ id: SCHEDULE_CANCEL_ACTION, label: translate(locale, "panel.automation.cancel"), data: schedule.id, weight: "text" as const, danger: true, glyph: "x" as const }]),
							{ id: SCHEDULE_EDIT_ACTION, label: translate(locale, "panel.automation.edit"), data: schedule.id, weight: "text" as const, glyph: "square-pen" as const,
								...(state.problem || schedule.pending !== null ? { disabled: true } : {}) },
							{ id: SCHEDULE_HISTORY_ACTION, label: translate(locale, "panel.automation.history"), data: schedule.id, weight: "text" as const, glyph: "folder" as const,
								...(schedule.history.length === 0 ? { disabled: true } : {}) },
							{
								id: SCHEDULE_REMOVE_ACTION,
								...(state.problem ? { disabled: true } : {}),
								label: translate(locale, "panel.automation.remove"),
								data: schedule.id,
								weight: "text" as const,
								danger: true,
								glyph: "x" as const,
							},
						],
					},
				})),
				empty: { cause: state.problem ? "failed" : "first-use", text: translate(locale, state.problem ? "panel.automation.unreadable" : "panel.automation.empty") },
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
	const requested = input.current ?? CHAT_VIEW;
	const current = input.availableViews !== undefined && requested !== CHAT_VIEW && !input.availableViews.includes(requested)
		? CHAT_VIEW : requested;
	const spec = panelSpec({ ...input, current });
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
		nav: panelNav(input.locale, current, input.availableViews),
		current: spec === undefined ? CHAT_VIEW : current,
		...(input.settingsSection === undefined ? {} : { settingsSection: input.settingsSection }),
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
		presentation: "drawer",
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
		presentation: "drawer",
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
 * The modal the context ring's compaction control opens. Instructions are optional: an empty field asks
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

/** Project overrides change only the settings supported by the shared MCP manager. */
export function mcpProjectModal(locale: Locale, server: { readonly name: string; readonly enabled: boolean; readonly exposure: string }): PanelModal {
	return {
		id: PLUGIN_MCP_PROJECT_MODAL,
		data: server.name,
		title: translate(locale, "panel.plugins.projectSettings"),
		description: translate(locale, "panel.plugins.projectSettingsHelp", { server: server.name }),
		fields: [
			{ id: "enabled", label: translate(locale, "panel.plugins.enabled"), kind: "checkbox", value: String(server.enabled) },
			{ id: "exposure", label: translate(locale, "panel.plugins.exposure"), kind: "select", value: server.exposure, options: mcpExposures(locale) },
		],
		submit: translate(locale, "modal.save"),
	};
}

/**
 * The modal a plan-a-prompt action opens: the text the host will send, and the gap between runs.
 */
export interface ScheduleEditorContext {
	readonly id: string;
	readonly sessionId?: string;
	readonly workspace: string;
	readonly workspaces: readonly { readonly value: string; readonly label: string }[];
	readonly models: readonly { readonly value: string; readonly label: string }[];
	readonly model: string;
}

export function addScheduleModal(locale: Locale, context: ScheduleEditorContext): PanelModal {
	return scheduleModal(locale, context);
}

export function editScheduleModal(locale: Locale, record: ScheduleRecordLike, context: ScheduleEditorContext): PanelModal {
	return scheduleModal(locale, { ...context, sessionId: record.target.kind === "session" ? record.target.sessionId : context.sessionId }, record);
}

function scheduleModal(locale: Locale, context: ScheduleEditorContext, record?: ScheduleRecordLike): PanelModal {
	const rule = record?.rule;
	const kind = rule?.kind ?? "interval";
	const timeZone = rule?.kind === "once" || rule?.kind === "cron" ? rule.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
	const options = (entries: readonly string[]) => entries.map((value) => ({ value, label: translate(locale, `modal.scheduleAdd.${value}` as MessageKey) }));
	const target = record?.target;
	const models = [...context.models], workspaces = [...context.workspaces];
	const model = target?.kind === "new_session" ? target.model : context.model;
	const workspace = target?.kind === "new_session" ? target.workspace : context.workspace;
	if (model && !models.some(item => item.value === model)) models.push({ value: model, label: model });
	if (!workspaces.some(item => item.value === workspace)) workspaces.push({ value: workspace, label: workspace });
	return {
		id: SCHEDULE_ADD_MODAL,
		title: translate(locale, record === undefined ? "modal.scheduleAdd.title" : "modal.scheduleAdd.editTitle"),
		description: translate(locale, "modal.scheduleAdd.description"),
		data: JSON.stringify({ id: context.id, sessionId: context.sessionId ?? "", projectId: target?.kind === "new_session" ? target.projectId : "", ...(record === undefined ? {} : { expectedGeneration: record.generation }) }),
		fields: [
			{ id: "targetKind", label: translate(locale, "modal.scheduleAdd.target"), kind: "select", value: target?.kind ?? "new_session", options: [{ value: "new_session", label: translate(locale, "modal.scheduleAdd.newSession") }, ...(context.sessionId ? [{ value: "session", label: `${translate(locale, "modal.scheduleAdd.existingSession")} · ${context.sessionId}` }] : [])] },
			{ id: "title", label: translate(locale, "modal.scheduleAdd.taskTitle"), kind: "text", value: target?.kind === "new_session" ? target.title : "", visibleWhen: { field: "targetKind", values: ["new_session"] } },
			{ id: "workspace", label: translate(locale, "modal.scheduleAdd.workspace"), kind: "select", value: workspace, options: workspaces, visibleWhen: { field: "targetKind", values: ["new_session"] } },
			{ id: "model", label: translate(locale, "modal.scheduleAdd.model"), kind: "select", value: model, options: [{ value: "", label: translate(locale, "modal.scheduleAdd.defaultModel") }, ...models], visibleWhen: { field: "targetKind", values: ["new_session"] } },
			{ id: "prompt", label: translate(locale, "modal.scheduleAdd.prompt"), kind: "textarea", value: record?.prompt ?? "", placeholder: translate(locale, "modal.scheduleAdd.promptPlaceholder") },
			{ id: "kind", label: translate(locale, "modal.scheduleAdd.kind"), kind: "select", value: kind, options: options(["interval", "once", "cron"]) },
			{ id: "everyMinutes", label: translate(locale, "modal.scheduleAdd.every"), kind: "text", inputType: "number", value: rule?.kind === "interval" ? String(rule.everyMinutes) : "15", visibleWhen: { field: "kind", values: ["interval"] } },
			{ id: "at", label: translate(locale, "modal.scheduleAdd.at"), kind: "text", inputType: "datetime-local", value: rule?.kind === "once" ? rule.at : "", visibleWhen: { field: "kind", values: ["once"] } },
			{ id: "expression", label: translate(locale, "modal.scheduleAdd.expression"), kind: "text", value: rule?.kind === "cron" ? rule.expression : "0 9 * * 1-5", description: translate(locale, "modal.scheduleAdd.cronHelp"), visibleWhen: { field: "kind", values: ["cron"] } },
			{ id: "timeZone", label: translate(locale, "modal.scheduleAdd.timeZone"), kind: "text", value: timeZone, description: translate(locale, "modal.scheduleAdd.zoneHelp"), visibleWhen: { field: "kind", values: ["once", "cron"] } },
			{ id: "busy", label: translate(locale, "modal.scheduleAdd.busy"), kind: "select", value: record?.busy ?? "queue", options: options(["queue", "skip"]), visibleWhen: { field: "targetKind", values: ["session"] } },
			{ id: "missed", label: translate(locale, "modal.scheduleAdd.missed"), kind: "select", value: record?.missed ?? "latest", options: options(["latest", "skip"]) },
			{ id: "graceMinutes", label: translate(locale, "modal.scheduleAdd.grace"), kind: "text", inputType: "number", value: String(record?.graceMinutes ?? 10) },
			{ id: "timeoutSeconds", label: translate(locale, "modal.scheduleAdd.timeout"), kind: "text", inputType: "number", value: String(record?.timeoutSeconds ?? 600) },
		],
		submit: translate(locale, record === undefined ? "modal.scheduleAdd.submit" : "modal.scheduleAdd.save"),
		presentation: "drawer",
	};
}

export function scheduleHistoryModal(locale: Locale, record: ScheduleRecordLike): PanelModal {
	const zone = record.rule.kind === "interval" ? Intl.DateTimeFormat().resolvedOptions().timeZone : record.rule.timeZone;
	const format = (at: number) => new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "medium", timeZone: zone }).format(at);
	const value = [...record.history].reverse().map((receipt) => [
		`${format(receipt.startedAt)} — ${scheduleOutcomeCopy(locale, receipt)}`,
		translate(locale, "panel.automation.historyFinished", { time: format(receipt.finishedAt) }),
		...(receipt.sessionId ? [translate(locale, "panel.automation.historySession", { session: receipt.sessionId })] : []),
		...(receipt.scheduledFor === null ? [] : [translate(locale, "panel.automation.historyDue", { time: format(receipt.scheduledFor) })]),
	].join("\n")).join("\n\n");
	return { id: SCHEDULE_HISTORY_MODAL, title: translate(locale, "panel.automation.history"), description: `${record.prompt} · ${translate(locale, "modal.scheduleAdd.timeZone")}: ${zone}`,
		fields: [{ id: "content", label: translate(locale, "panel.automation.history"), kind: "textarea", value, readOnly: true }], submit: translate(locale, "panel.dismiss"), presentation: "drawer" };
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
