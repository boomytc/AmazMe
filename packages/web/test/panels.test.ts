import { describe, expect, test } from "vitest";
import {
	CHAT_VIEW,
	composeSkill,
	mcpExposures,
	newSkillModal,
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

const UNAVAILABLE_EN = "The host did not offer this service.";
const UNAVAILABLE_ZH = "宿主未提供该服务。";

/** A catalogue entry: the host publishes identities, so a fixture only needs the shape. */
function descriptor(overrides: Partial<SettingDescriptorLike> & { id: string }): SettingDescriptorLike {
	return {
		group: "conversation",
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
		descriptor({
			id: "steeringMode",
			kind: "enum",
			value: "all",
			options: ["one-at-a-time", "all"],
		}),
		descriptor({ id: "compactionEnabled", value: "false", explicit: false }),
		descriptor({ id: "httpIdleTimeoutMs", group: "network-retries", kind: "number", value: "30000", min: 0, step: 1000 }),
		descriptor({ id: "shellPath", group: "shell", kind: "string", value: "" }),
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
		const nav = panelNav("en", "skills");
		expect(nav.map((item) => item.id)).toEqual(["plugins", "skills", SETTINGS_VIEW]);
		expect(nav.filter((item) => item.active)).toEqual([{ id: "skills", label: "Skills", glyph: "skills", active: true }]);
		expect(panelNav("en", CHAT_VIEW).every((item) => !item.active)).toBe(true);
	});

	test("names the management rows in the reader's language", () => {
		expect(panelNav("zh", "plugins").map((item) => item.label)).toEqual(["插件", "技能", "设置"]);
		expect(panelNav("en", "plugins").map((item) => item.label)).toEqual(["Plugins", "Skills", "Settings"]);
	});

	test("shows no panel for the conversation and one for each management view", () => {
		expect(panelView({ locale: "en" }).current).toBe(CHAT_VIEW);
		expect(panelView({ locale: "en" }).panel).toBeUndefined();
		expect(panelView({ locale: "en", current: "plugins" }).panel?.id).toBe("plugins");
		expect(panelView({ locale: "en", current: SETTINGS_VIEW }).panel?.id).toBe(SETTINGS_VIEW);
		expect(panelSpec({ locale: "en", current: "skills" })?.id).toBe("skills");
		// An unknown view falls back to the conversation instead of a broken panel.
		expect(panelView({ locale: "en", current: "nope" }).current).toBe(CHAT_VIEW);
		expect(panelView({ locale: "en", current: "nope", modal: newSkillModal("en") }).modal?.id).toBe(SKILL_CREATE_MODAL);
	});
});

describe("settings panel", () => {
	test("explains itself while the host offers no service", () => {
		const panel = settingsPanel("en", { state: undefined  });
		expect(panel.groups).toEqual([]);
		expect(panel.notices).toEqual([{ tone: "info", text: UNAVAILABLE_EN }]);
		expect(settingsPanel("zh", { state: undefined  }).notices[0]?.text).toBe(UNAVAILABLE_ZH);
	});

	test("groups the host's descriptors in the order they arrive", () => {
		const panel = settingsPanel("en", { state: SETTINGS  });
		expect(panel.groups.map((group) => group.title)).toEqual(["Conversation", "Network & retries", "Shell", "Files"]);
		const conversation = panel.groups[0];
		expect(conversation?.rows.map((row) => row.title)).toEqual(["Steering mode", "Auto-compact"]);
		expect(conversation?.rows[0]?.controls).toEqual([
			{
				id: SETTINGS_FIELD_ACTION,
				data: "steeringMode",
				value: "all",
				kind: "select",
				options: [
					{ value: "one-at-a-time", label: "One at a time" },
					{ value: "all", label: "All at once" },
				],
			},
		]);
		// An unset field is marked, and a set one is not.
		expect(conversation?.rows[0]?.badges).toBeUndefined();
		expect(conversation?.rows[1]?.badges).toEqual(["default"]);
		expect(panel.groups[1]?.rows[0]?.controls?.[0]).toMatchObject({ kind: "number", min: 0, step: 1000, value: "30000" });
		expect(panel.groups[2]?.rows[0]?.controls?.[0]).toMatchObject({ kind: "text", placeholder: "System default" });
	});

	test("names the catalogue in the reader's language, falling back to the field's id", () => {
		const zh = settingsPanel("zh", { state: SETTINGS  });
		expect(zh.groups.map((group) => group.title)).toEqual(["对话", "网络与重试", "Shell", "文件"]);
		expect(zh.groups[0]?.rows.map((row) => row.title)).toEqual(["介入方式", "自动压缩"]);
		expect(zh.groups[0]?.rows[1]?.badges).toEqual(["默认"]);
		expect(zh.groups[0]?.rows[0]?.controls?.[0]?.options?.map((option) => option.label)).toEqual([
			"逐条应用",
			"全部应用",
		]);
		expect(zh.groups[2]?.rows[0]?.controls?.[0]).toMatchObject({ kind: "text", placeholder: "系统默认" });
		// A heading or field the dictionaries do not know shows its own token rather than nothing.
		const unknown = settingsPanel("zh", {
			state: { ...SETTINGS, descriptors: [descriptor({ id: "futureField", group: "future-group" })] },
		});
		expect(unknown.groups[0]?.title).toBe("future-group");
		expect(unknown.groups[0]?.rows[0]?.title).toBe("futureField");
	});

	test("names the reasoning levels with the shared effort names", () => {
		const panel = settingsPanel("zh", {
			state: {
				...SETTINGS,
				descriptors: [
					descriptor({
						id: "defaultThinkingLevel",
						group: "models-reasoning",
						kind: "enum",
						value: "medium",
						options: ["off", "medium", "xhigh"],
					}),
				],
			},
		});
		expect(panel.groups[0]?.title).toBe("模型与推理");
		expect(panel.groups[0]?.rows[0]?.controls?.[0]?.options).toEqual([
			{ value: "off", label: "关闭" },
			{ value: "medium", label: "中" },
			{ value: "xhigh", label: "极高" },
		]);
	});

	test("lists the files it reads and offers a re-read", () => {
		const files = settingsPanel("en", { state: SETTINGS  }).groups.at(-1);
		expect(files?.id).toBe("settings:files");
		expect(files?.actions).toEqual([{ id: SETTINGS_RELOAD_ACTION, label: "Re-read files", tone: "default" }]);
		expect(files?.rows).toEqual([
			{ id: "settings:global-path", title: "Global settings", value: "/agent/settings.json" },
			{ id: "settings:project-path", title: "Project settings", value: "/project/.amazme/settings.json" },
		]);
	});

	test("reports a settings file it could not parse, and an untrusted project", () => {
		const panel = settingsPanel("en", { state: SETTINGS  });
		expect(panel.notices).toEqual([
			{ tone: "error", text: "Project settings (/project/.amazme/settings.json): unexpected token" },
		]);
		expect(settingsPanel("zh", { state: SETTINGS  }).notices[0]?.text).toBe(
			"项目设置（/project/.amazme/settings.json）：unexpected token",
		);
		const untrusted = settingsPanel("en", {
			state: { ...SETTINGS, projectTrusted: false, paths: { global: "/agent/settings.json" } },
		});
		expect(untrusted.groups.at(-1)?.rows[1]?.description).toBe("The project is not trusted, so its settings are not read.");
	});
});

describe("skills panel", () => {
	test("lists each skill with its scope and the actions its location allows", () => {
		const panel = skillsPanel("en", { state: SKILLS });
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

	test("names scopes and actions in the reader's language", () => {
		const zh = skillsPanel("zh", { state: SKILLS });
		const rows = zh.groups[0]?.rows ?? [];
		expect(rows[0]?.badges).toEqual(["用户"]);
		expect(rows[1]?.badges).toEqual(["项目", "仅命令"]);
		expect(rows[0]?.actions?.map((action) => action.label)).toEqual(["编辑", "删除"]);
		expect(rows[1]?.actions?.map((action) => action.label)).toEqual(["查看"]);
		expect(zh.groups[0]?.actions?.map((action) => action.label)).toEqual(["新建技能", "导入…"]);
		// The host's own diagnostic message stays as the host wrote it.
		expect(zh.notices[0]?.text).toBe("/agent/skills/broken/SKILL.md: description is required");
	});

	test("names the empty state and the unavailable line", () => {
		expect(
			skillsPanel("en", { state: { directory: "/agent/skills", skills: [], diagnostics: [] } }).groups[0]?.empty,
		).toContain("No skills yet");
		expect(skillsPanel("en", { state: undefined }).notices[0]?.text).toBe(UNAVAILABLE_EN);
	});

	test("opens a create form, the file itself, and a remove confirmation", () => {
		const create = newSkillModal("en");
		expect(create.fields.map((field) => field.id)).toEqual(["name", "description", "body"]);
		expect(create.fields.map((field) => field.label)).toEqual(["Name", "Description", "Instructions"]);
		const edit = skillModal("en", "weekly-report", "---\nname: weekly-report\n---\n", true);
		expect(edit).toMatchObject({ id: SKILL_EDIT_MODAL, data: "weekly-report", submit: "Save" });
		expect(edit.fields[0]?.value).toContain("name: weekly-report");
		const view = skillModal("en", "project-notes", "---\n---\n", false);
		expect(view).toMatchObject({ id: SKILL_VIEW_MODAL, submit: "Close" });
		expect(removeSkillModal("en", "weekly-report")).toMatchObject({
			id: SKILL_REMOVE_MODAL,
			data: "weekly-report",
			danger: true,
			fields: [],
		});
	});

	test("names a modal's title, fields, and submit in the reader's language", () => {
		const zh = skillModal("zh", "weekly-report", "---\n---\n", true);
		expect(zh.title).toBe("编辑 weekly-report");
		expect(zh.submit).toBe("保存");
		expect(newSkillModal("zh").fields.map((field) => field.label)).toEqual(["名称", "描述", "指令"]);
		expect(removeSkillModal("zh", "weekly-report").title).toBe("删除 weekly-report？");
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
		const panel = pluginsPanel("en", { state: PLUGINS });
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
		const rows = pluginsPanel("en", { state: PLUGINS }).groups[1]?.rows ?? [];
		expect(rows[0]?.controls).toEqual([
			{ id: PLUGIN_MCP_ENABLED_ACTION, kind: "switch", data: "filesystem", value: "false" },
			{
				id: PLUGIN_MCP_EXPOSURE_ACTION,
				kind: "select",
				data: "filesystem",
				value: "direct",
				options: mcpExposures("en"),
			},
		]);
		expect(rows[0]?.actions?.[0]).toMatchObject({ id: "plugins:mcp-remove", data: "filesystem", tone: "danger" });
		expect(rows[1]?.controls).toBeUndefined();
		expect(rows[1]?.actions?.[0]).toMatchObject({ label: "From extension", disabled: true });
		expect(rows[1]?.badges).toEqual(["extension", "Codemode"]);
	});

	test("names exposures, scopes, and actions in the reader's language", () => {
		expect(mcpExposures("zh").map((option) => option.label)).toEqual(["代码模式", "延迟", "直接", "隐藏"]);
		const zh = pluginsPanel("zh", { state: PLUGINS });
		expect(zh.groups.map((group) => group.title)).toEqual(["插件包", "MCP 服务"]);
		const rows = zh.groups[1]?.rows ?? [];
		expect(rows[0]?.badges).toEqual(["全局", "直接"]);
		expect(rows[0]?.controls?.[1]?.options).toEqual(mcpExposures("zh"));
		expect(rows[1]?.actions?.[0]?.label).toBe("来自扩展");
	});

	test("reports a broken mcp.json and the empty states", () => {
		const panel = pluginsPanel("en", { state: PLUGINS });
		expect(panel.notices).toEqual([
			{ tone: "error", text: '/project/.amazme/mcp.json: server "x" needs either "command" or "url"' },
		]);
		const empty = pluginsPanel("en", { state: { packages: [], mcp: { ...PLUGINS.mcp, servers: [], errors: [] } } });
		expect(empty.groups[0]?.empty).toContain("built-in facets only");
		expect(empty.groups[1]?.empty).toContain("/agent/mcp.json");
		expect(empty.groups[1]?.footnote).toContain("does not connect MCP servers yet");
	});

	test("explains itself while the host offers no service", () => {
		expect(pluginsPanel("en", { state: undefined }).notices[0]?.text).toBe(UNAVAILABLE_EN);
	});
});
