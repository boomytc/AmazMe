import { describe, expect, test } from "vitest";
import {
	CHAT_VIEW,
	composeSkill,
	MCP_EXPOSURES,
	newSkillModal,
	PANEL_UNAVAILABLE,
	panelNav,
	panelSpec,
	panelView,
	PLUGIN_MCP_ENABLED_ACTION,
	PLUGIN_MCP_EXPOSURE_ACTION,
	PLUGIN_PACKAGE_REMOVE_ACTION,
	pluginsPanel,
	removeSkillModal,
	SETTINGS_FIELD_ACTION,
	SETTINGS_RELOAD_ACTION,
	SETTINGS_VIEW,
	settingsPanel,
	skillModal,
	skillsPanel,
	SKILL_CREATE_MODAL,
	SKILL_EDIT_ACTION,
	SKILL_EDIT_MODAL,
	SKILL_REMOVE_ACTION,
	SKILL_REMOVE_MODAL,
	SKILL_VIEW_MODAL,
	type PluginsStateLike,
	type SettingDescriptorLike,
	type SettingsStateLike,
	type SkillsStateLike,
} from "../src/panels.ts";

function descriptor(overrides: Partial<SettingDescriptorLike> & { id: string }): SettingDescriptorLike {
	return {
		label: overrides.id,
		description: `${overrides.id} description`,
		group: "Conversation",
		kind: "boolean",
		field: overrides.id,
		explicit: true,
		value: "true",
		...overrides,
	};
}

const SETTINGS: SettingsStateLike = {
	paths: { global: "/agent/settings.json", project: "/project/.amazme/settings.json" },
	projectTrusted: true,
	descriptors: [
		descriptor({ id: "steeringMode", group: "Conversation", kind: "enum", value: "all", options: [{ value: "all", label: "All at once" }] }),
		descriptor({ id: "compactionEnabled", group: "Conversation", value: "false", explicit: false }),
		descriptor({ id: "httpIdleTimeoutMs", group: "Network & retries", kind: "number", value: "30000", min: 0, step: 1000 }),
		descriptor({ id: "shellPath", group: "Shell", kind: "string", value: "", placeholder: "System default" }),
	],
	errors: [{ scope: "project", path: "/project/.amazme/settings.json", message: "unexpected token" }],
};

const SKILLS: SkillsStateLike = {
	directory: "/agent/skills",
	skills: [
		{
			name: "weekly-report",
			description: "Draft the weekly report",
			filePath: "/agent/skills/weekly-report/SKILL.md",
			scope: "user",
			disableModelInvocation: false,
			editable: true,
		},
		{
			name: "project-notes",
			description: "Workspace notes",
			filePath: "/project/.amazme/skills/project-notes/SKILL.md",
			scope: "project",
			disableModelInvocation: true,
			editable: false,
		},
	],
	diagnostics: [{ path: "/agent/skills/broken/SKILL.md", message: "description is required" }],
};

const PLUGINS: PluginsStateLike = {
	packages: ["/tmp/example-plugin"],
	mcp: {
		servers: [
			{
				name: "filesystem",
				detail: "npx -y server-filesystem .",
				scope: "global",
				enabled: false,
				exposure: "direct",
				editable: true,
			},
			{ name: "hosted", detail: "https://mcp.example/mcp", scope: "extension", enabled: true, exposure: "codemode", editable: false },
		],
		errors: ["/project/.amazme/mcp.json: server \"x\" needs either \"command\" or \"url\""],
		globalPath: "/agent/mcp.json",
		projectPath: "/project/.amazme/mcp.json",
	},
};

describe("panel navigation", () => {
	test("marks the open view and always carries the settings entry", () => {
		const nav = panelNav("skills");
		expect(nav.map((item) => item.id)).toEqual(["plugins", "skills", SETTINGS_VIEW]);
		expect(nav.filter((item) => item.active)).toEqual([{ id: "skills", label: "Skills", glyph: "skills", active: true }]);
		expect(panelNav(CHAT_VIEW).every((item) => !item.active)).toBe(true);
	});

	test("shows no panel for the conversation and one for each management view", () => {
		expect(panelView({}).current).toBe(CHAT_VIEW);
		expect(panelView({}).panel).toBeUndefined();
		expect(panelView({ current: "plugins" }).panel?.id).toBe("plugins");
		expect(panelView({ current: SETTINGS_VIEW }).panel?.id).toBe(SETTINGS_VIEW);
		expect(panelSpec({ current: "skills" })?.id).toBe("skills");
		// An unknown view falls back to the conversation instead of a broken panel.
		expect(panelView({ current: "nope" }).current).toBe(CHAT_VIEW);
		expect(panelView({ current: "nope", modal: newSkillModal() }).modal?.id).toBe(SKILL_CREATE_MODAL);
	});
});

describe("settings panel", () => {
	test("explains itself while the host offers no service", () => {
		const panel = settingsPanel({ state: undefined });
		expect(panel.groups).toEqual([]);
		expect(panel.notices).toEqual([{ tone: "info", text: PANEL_UNAVAILABLE }]);
	});

	test("groups the host's descriptors in the order they arrive", () => {
		const panel = settingsPanel({ state: SETTINGS });
		expect(panel.groups.map((group) => group.title)).toEqual(["Conversation", "Network & retries", "Shell", "Files"]);
		const conversation = panel.groups[0];
		expect(conversation?.rows.map((row) => row.title)).toEqual(["steeringMode", "compactionEnabled"]);
		expect(conversation?.rows[0]?.controls).toEqual([
			{ id: SETTINGS_FIELD_ACTION, data: "steeringMode", value: "all", kind: "select", options: [{ value: "all", label: "All at once" }] },
		]);
		// An unset field is marked, and a set one is not.
		expect(conversation?.rows[0]?.badges).toBeUndefined();
		expect(conversation?.rows[1]?.badges).toEqual(["default"]);
		expect(panel.groups[1]?.rows[0]?.controls?.[0]).toMatchObject({ kind: "number", min: 0, step: 1000, value: "30000" });
		expect(panel.groups[2]?.rows[0]?.controls?.[0]).toMatchObject({ kind: "text", placeholder: "System default" });
	});

	test("lists the files it reads and offers a re-read", () => {
		const files = settingsPanel({ state: SETTINGS }).groups.at(-1);
		expect(files?.id).toBe("settings:files");
		expect(files?.actions).toEqual([{ id: SETTINGS_RELOAD_ACTION, label: "Re-read files", tone: "default" }]);
		expect(files?.rows).toEqual([
			{ id: "settings:global-path", title: "Global settings", value: "/agent/settings.json" },
			{ id: "settings:project-path", title: "Project settings", value: "/project/.amazme/settings.json" },
		]);
	});

	test("reports a settings file it could not parse, and an untrusted project", () => {
		const panel = settingsPanel({ state: SETTINGS });
		expect(panel.notices).toEqual([
			{ tone: "error", text: "project settings (/project/.amazme/settings.json): unexpected token" },
		]);
		const untrusted = settingsPanel({ state: { ...SETTINGS, projectTrusted: false, paths: { global: "/agent/settings.json" } } });
		expect(untrusted.groups.at(-1)?.rows[1]?.description).toBe("The project is not trusted, so its settings are not read.");
	});
});

describe("skills panel", () => {
	test("lists each skill with its scope and the actions its location allows", () => {
		const panel = skillsPanel({ state: SKILLS });
		const rows = panel.groups[0]?.rows ?? [];
		expect(rows.map((row) => row.title)).toEqual(["weekly-report", "project-notes"]);
		expect(rows[0]).toMatchObject({
			description: "Draft the weekly report",
			badges: ["user"],
			value: "/agent/skills/weekly-report/SKILL.md",
		});
		expect(rows[0]?.actions?.map((action) => action.label)).toEqual(["Edit", "Remove"]);
		expect(rows[0]?.actions?.[0]).toMatchObject({ id: SKILL_EDIT_ACTION, data: "weekly-report" });
		expect(rows[0]?.actions?.[1]).toMatchObject({ id: SKILL_REMOVE_ACTION, data: "weekly-report", tone: "danger" });
		// A project skill is read-only here: no Remove, and View instead of Edit.
		expect(rows[1]?.badges).toEqual(["project", "command only"]);
		expect(rows[1]?.actions?.map((action) => action.label)).toEqual(["View"]);
		expect(panel.notices).toEqual([
			{ tone: "error", text: "/agent/skills/broken/SKILL.md: description is required" },
		]);
		expect(panel.groups[0]?.actions?.map((action) => action.label)).toEqual(["New skill", "Import…"]);
		expect(panel.groups[0]?.footnote).toContain("/agent/skills");
	});

	test("names the empty state and the unavailable line", () => {
		expect(skillsPanel({ state: { directory: "/agent/skills", skills: [], diagnostics: [] } }).groups[0]?.empty).toContain(
			"No skills yet",
		);
		expect(skillsPanel({ state: undefined }).notices[0]?.text).toBe(PANEL_UNAVAILABLE);
	});

	test("opens a create form, the file itself, and a remove confirmation", () => {
		const create = newSkillModal();
		expect(create.fields.map((field) => field.id)).toEqual(["name", "description", "body"]);
		const edit = skillModal("weekly-report", "---\nname: weekly-report\n---\n", true);
		expect(edit).toMatchObject({ id: SKILL_EDIT_MODAL, data: "weekly-report", submit: "Save" });
		expect(edit.fields[0]?.value).toContain("name: weekly-report");
		const view = skillModal("project-notes", "---\n---\n", false);
		expect(view).toMatchObject({ id: SKILL_VIEW_MODAL, submit: "Close" });
		expect(removeSkillModal("weekly-report")).toMatchObject({
			id: SKILL_REMOVE_MODAL,
			data: "weekly-report",
			danger: true,
			fields: [],
		});
	});

	test("composes the SKILL.md a create submits", () => {
		expect(composeSkill("weekly-report", "Draft the weekly report", "  Step one.  ")).toBe(
			"---\nname: weekly-report\ndescription: Draft the weekly report\n---\n\nStep one.\n",
		);
		expect(composeSkill("empty", "Nothing to do", "   ")).toBe("---\nname: empty\ndescription: Nothing to do\n---\n\n");
	});
});

describe("plugins panel", () => {
	test("lists the packages with a remove per row and an add in the header", () => {
		const panel = pluginsPanel({ state: PLUGINS });
		const group = panel.groups[0];
		expect(group?.title).toBe("Plugin packages");
		expect(group?.actions?.[0]?.label).toBe("Add package…");
		expect(group?.rows[0]).toEqual({
			id: "package:/tmp/example-plugin",
			title: "/tmp/example-plugin",
			actions: [{ id: PLUGIN_PACKAGE_REMOVE_ACTION, label: "Remove", data: "/tmp/example-plugin", tone: "danger" }],
		});
	});

	test("gives a configurable MCP server a switch and an exposure, and locks one from an extension", () => {
		const rows = pluginsPanel({ state: PLUGINS }).groups[1]?.rows ?? [];
		expect(rows[0]?.controls).toEqual([
			{ id: PLUGIN_MCP_ENABLED_ACTION, kind: "switch", data: "filesystem", value: "false" },
			{
				id: PLUGIN_MCP_EXPOSURE_ACTION,
				kind: "select",
				data: "filesystem",
				value: "direct",
				options: MCP_EXPOSURES,
			},
		]);
		expect(rows[0]?.actions?.[0]).toMatchObject({ id: "plugins:mcp-remove", data: "filesystem", tone: "danger" });
		expect(rows[1]?.controls).toBeUndefined();
		expect(rows[1]?.actions?.[0]).toMatchObject({ label: "From extension", disabled: true });
		expect(rows[1]?.badges).toEqual(["extension", "codemode"]);
	});

	test("reports a broken mcp.json and the empty states", () => {
		const panel = pluginsPanel({ state: PLUGINS });
		expect(panel.notices).toEqual([
			{ tone: "error", text: '/project/.amazme/mcp.json: server "x" needs either "command" or "url"' },
		]);
		const empty = pluginsPanel({ state: { packages: [], mcp: { ...PLUGINS.mcp, servers: [], errors: [] } } });
		expect(empty.groups[0]?.empty).toContain("built-in facets only");
		expect(empty.groups[1]?.empty).toContain("/agent/mcp.json");
		expect(empty.groups[1]?.footnote).toContain("does not connect MCP servers yet");
	});

	test("explains itself while the host offers no service", () => {
		expect(pluginsPanel({ state: undefined }).notices[0]?.text).toBe(PANEL_UNAVAILABLE);
	});
});
