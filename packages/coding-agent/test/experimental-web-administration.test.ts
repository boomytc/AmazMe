import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { replicatedState } from "@amazme/chord";
import { copyIdentities, settingFieldCopy, settingOptionCopy } from "@amazme/web";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createPluginsService } from "../src/experimental/services/plugins-provider.ts";
import type { PluginsState } from "../src/experimental/services/plugins.ts";
import { applySetting, describeSettings, settingsSnapshot } from "../src/experimental/services/settings-provider.ts";
import type { SettingsState } from "../src/experimental/services/settings.ts";
import { createSkillsService } from "../src/experimental/services/skills-provider.ts";
import type { SkillsState } from "../src/experimental/services/skills.ts";

const directories = new Set<string>();

async function makeDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

function skillFile(name: string, description = `${name} skill`): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the thing.\n`;
}

describe("settings catalogue", () => {
	test("reads the manager's fields as descriptors with their file keys", () => {
		const manager = SettingsManager.inMemory({ steeringMode: "all", compaction: { enabled: false } });
		const descriptors = describeSettings(manager);
		const steering = descriptors.find((descriptor) => descriptor.id === "steeringMode");
		// The catalogue publishes identities and tokens; the page owns the copy for them.
		expect(steering).toMatchObject({
			group: "conversation",
			kind: "enum",
			field: "steeringMode",
			value: "all",
			explicit: true,
		});
		expect(steering?.options).toEqual(["one-at-a-time", "all"]);
		const compaction = descriptors.find((descriptor) => descriptor.id === "compactionEnabled");
		expect(compaction).toMatchObject({ field: "compaction.enabled", value: "false", kind: "boolean" });
		const followUp = descriptors.find((descriptor) => descriptor.id === "followUpMode");
		expect(followUp).toMatchObject({ value: "one-at-a-time", explicit: false });
	});

	test("applies a field to the manager and reports it as set", async () => {
		const manager = SettingsManager.inMemory({});
		expect(describeSettings(manager).find((d) => d.id === "retryEnabled")).toMatchObject({
			value: "true",
			explicit: false,
		});
		const errors = await applySetting(manager, "retryEnabled", "false");
		expect(errors).toEqual([]);
		expect(manager.getRetryEnabled()).toBe(false);
		expect(describeSettings(manager).find((d) => d.id === "retryEnabled")).toMatchObject({
			value: "false",
			explicit: true,
		});
	});

	test("coerces each kind and rejects a value the field cannot take", async () => {
		const manager = SettingsManager.inMemory({});
		await applySetting(manager, "httpIdleTimeoutMs", "45000");
		expect(manager.getHttpIdleTimeoutMs()).toBe(45000);
		await applySetting(manager, "shellPath", "");
		expect(manager.getShellPath()).toBeUndefined();
		await applySetting(manager, "shellPath", "/bin/zsh");
		expect(manager.getShellPath()).toBe("/bin/zsh");
		await expect(applySetting(manager, "steeringMode", "sometimes")).rejects.toThrow(/takes one of/);
		await expect(applySetting(manager, "httpIdleTimeoutMs", "-1")).rejects.toThrow(/whole number/);
		await expect(applySetting(manager, "compactionEnabled", "yes")).rejects.toThrow(/true or false/);
		await expect(applySetting(manager, "nope", "1")).rejects.toThrow(/Unknown setting/);
	});

	test("writes the interface language and palette preferences, and rejects an unshipped one", async () => {
		const manager = SettingsManager.inMemory({});
		await applySetting(manager, "locale", "zh");
		await applySetting(manager, "appearance", "dark");
		expect(manager.getLocalePreference()).toBe("zh");
		expect(manager.getAppearancePreference()).toBe("dark");
		expect(describeSettings(manager).find((descriptor) => descriptor.id === "locale")).toMatchObject({
			group: "interface",
			field: "locale",
			kind: "enum",
			options: ["auto", "zh", "en"],
			value: "zh",
			explicit: true,
		});
		expect(SettingsManager.inMemory({}).getAppearancePreference()).toBe("system");
		// A hand-edited file is not validated: a value this build does not ship falls back.
		const agentDir = await makeDirectory("prefs-agent-");
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ locale: "ja", appearance: "sepia" }), "utf8");
		const edited = SettingsManager.create(await makeDirectory("prefs-project-"), agentDir);
		expect(edited.getLocalePreference()).toBe("auto");
		expect(edited.getAppearancePreference()).toBe("system");
		await expect(applySetting(manager, "locale", "ja")).rejects.toThrow(/locale takes one of/);
		await expect(applySetting(manager, "appearance", "sepia")).rejects.toThrow(/appearance takes one of/);
	});

	test("names every catalogue identity the host publishes in both languages", () => {
		const descriptors = describeSettings(SettingsManager.inMemory({}));
		const en = copyIdentities("en");
		const zh = copyIdentities("zh");
		for (const descriptor of descriptors) {
			expect(zh.settingFields, descriptor.id).toContain(descriptor.id);
			expect(en.settingFields, descriptor.id).toContain(descriptor.id);
			expect(zh.settingGroups, descriptor.group).toContain(descriptor.group);
			expect(en.settingGroups, descriptor.group).toContain(descriptor.group);
			const copy = settingFieldCopy("zh", descriptor.id);
			expect(copy.label, descriptor.id).not.toBe(descriptor.id);
			expect(copy.description.length, descriptor.id).toBeGreaterThan(0);
			// Every stored enum value has a name of its own, so a control never shows a bare token.
			// The reasoning levels are the exception: they share the effort names the picker uses.
			if (descriptor.kind !== "enum" || descriptor.id === "defaultThinkingLevel") continue;
			expect(zh.settingOptions[descriptor.id], descriptor.id).toBeDefined();
			for (const option of descriptor.options ?? []) {
				expect(settingOptionCopy("zh", descriptor.id, option), `${descriptor.id}=${option}`).not.toBe(option);
				expect(settingOptionCopy("en", descriptor.id, option), `${descriptor.id}=${option}`).not.toBe(option);
			}
		}
		expect(descriptors.map((descriptor) => descriptor.id)).toEqual(
			expect.arrayContaining(["locale", "appearance"]),
		);
	});

	test("carries the settings files and the project's trust through the state", () => {
		const manager = SettingsManager.inMemory({});
		const snapshot = settingsSnapshot({
			manager,
			agentDir: "/tmp/agent",
			cwd: "/tmp/project",
			paths: { global: "/tmp/agent/settings.json", project: "/tmp/project/.amazme/settings.json" },
			errors: [],
		});
		expect(snapshot.paths.global).toBe("/tmp/agent/settings.json");
		expect(snapshot.projectTrusted).toBe(true);
		expect(snapshot.descriptors.length).toBeGreaterThan(10);
		expect(snapshot.errors).toEqual([]);
	});
});

describe("skills surface", () => {
	async function service(): Promise<{
		readonly runtime: ReturnType<typeof createSkillsService>;
		readonly agentDir: string;
		readonly cwd: string;
	}> {
		const agentDir = await makeDirectory("skills-agent-");
		const cwd = await makeDirectory("skills-project-");
		const runtime = createSkillsService(
			{ agentDir, cwd, skillPaths: () => [] },
			replicatedState<SkillsState>,
		);
		runtime.refresh(BACKGROUND_CONTEXT);
		return { runtime, agentDir, cwd };
	}

	test("writes, lists, reads, and removes an agent-directory skill", async () => {
		const { runtime, agentDir } = await service();
		expect(runtime.service.state.value.skills).toEqual([]);
		await runtime.service.write({ name: "weekly-report", content: skillFile("weekly-report") }, BACKGROUND_CONTEXT);
		const listed = runtime.service.state.value.skills;
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			name: "weekly-report",
			description: "weekly-report skill",
			scope: "user",
			editable: true,
		});
		expect(listed[0]?.filePath).toBe(join(agentDir, "skills", "weekly-report", "SKILL.md"));
		await expect(runtime.service.read("weekly-report", BACKGROUND_CONTEXT)).resolves.toContain("Do the thing.");
		await runtime.service.remove("weekly-report", BACKGROUND_CONTEXT);
		expect(runtime.service.state.value.skills).toEqual([]);
	});

	test("rejects a name outside the skill spec and a skill without a description", async () => {
		const { runtime } = await service();
		await expect(
			runtime.service.write({ name: "Weekly Report", content: skillFile("weekly-report") }, BACKGROUND_CONTEXT),
		).rejects.toThrow(/lowercase letters/);
		await expect(
			runtime.service.write({ name: "weekly-report", content: "---\nname: weekly-report\n---\n\nbody\n" }, BACKGROUND_CONTEXT),
		).rejects.toThrow(/needs a description/);
		await expect(
			runtime.service.write({ name: "weekly-report", content: skillFile("other-name") }, BACKGROUND_CONTEXT),
		).rejects.toThrow(/does not match/);
	});

	test("imports a skill folder and refuses to overwrite an existing name", async () => {
		const { runtime, agentDir } = await service();
		const source = await makeDirectory("skills-source-");
		await mkdir(source, { recursive: true });
		await writeFile(join(source, "SKILL.md"), skillFile("imported-skill"), "utf8");
		await writeFile(join(source, "notes.md"), "extra\n", "utf8");
		await runtime.service.importSkill(source, BACKGROUND_CONTEXT);
		expect(runtime.service.state.value.skills.map((skill) => skill.name)).toEqual(["imported-skill"]);
		// The whole folder is copied, so a skill's referenced files come with it.
		await expect(readFile(join(agentDir, "skills", "imported-skill", "notes.md"), "utf8")).resolves.toBe("extra\n");
		await expect(runtime.service.importSkill(source, BACKGROUND_CONTEXT)).rejects.toThrow(/already exists/);
	});

	test("lists a project skill as read-only and refuses to remove it", async () => {
		const { runtime, cwd } = await service();
		const projectSkill = join(cwd, ".amazme", "skills", "project-only", "SKILL.md");
		await mkdir(join(cwd, ".amazme", "skills", "project-only"), { recursive: true });
		await writeFile(projectSkill, skillFile("project-only"), "utf8");
		await runtime.service.reload(BACKGROUND_CONTEXT);
		const listed = runtime.service.state.value.skills;
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ name: "project-only", scope: "project", editable: false });
		await expect(runtime.service.remove("project-only", BACKGROUND_CONTEXT)).rejects.toThrow(/not an agent-directory/);
		await expect(stat(projectSkill)).resolves.toBeTruthy();
	});

	test("reports a skill path that does not exist", async () => {
		const { runtime } = await service();
		await expect(runtime.service.importSkill("/nope/nowhere", BACKGROUND_CONTEXT)).rejects.toThrow(
			/Skill path does not exist/,
		);
	});
});

describe("plugins surface", () => {
	async function service(packages: readonly string[] = []): Promise<{
		readonly runtime: ReturnType<typeof createPluginsService>;
		readonly agentDir: string;
		readonly cwd: string;
		readonly selected: string[][];
	}> {
		const agentDir = await makeDirectory("plugins-agent-");
		const cwd = await makeDirectory("plugins-project-");
		const selected: string[][] = [];
		let current = [...packages];
		const runtime = createPluginsService(
			{
				agentDir,
				cwd,
				projectTrusted: true,
				packages: {
					list: () => current,
					set: async (paths) => {
						// The host builds every package before it lands; a path the builder rejects propagates.
						if (paths.some((path) => path.includes("unbuildable"))) throw new Error("package does not build");
						selected.push([...paths]);
						current = [...paths];
						return current;
					},
				},
			},
			replicatedState<PluginsState>,
		);
		runtime.reload(BACKGROUND_CONTEXT);
		return { runtime, agentDir, cwd, selected };
	}

	test("adds, disables, re-exposes, and removes an MCP server", async () => {
		const { runtime, agentDir } = await service();
		expect(runtime.service.state.value.mcp.servers).toEqual([]);
		await runtime.service.addMcpServer(
			"filesystem",
			JSON.stringify({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] }),
			BACKGROUND_CONTEXT,
		);
		const added = runtime.service.state.value.mcp.servers;
		expect(added).toHaveLength(1);
		expect(added[0]).toMatchObject({
			name: "filesystem",
			detail: "npx -y @modelcontextprotocol/server-filesystem .",
			scope: "global",
			enabled: true,
			exposure: "codemode",
			editable: true,
		});
		await runtime.service.setMcpServer("filesystem", { enabled: false }, BACKGROUND_CONTEXT);
		expect(runtime.service.state.value.mcp.servers[0]).toMatchObject({ enabled: false, exposure: "codemode" });
		await runtime.service.setMcpServer("filesystem", { exposure: "direct" }, BACKGROUND_CONTEXT);
		expect(runtime.service.state.value.mcp.servers[0]).toMatchObject({ enabled: false, exposure: "direct" });
		// The two changes land in the same file the CLI and TUI read.
		const written = JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8")) as {
			mcpServers: Record<string, { enabled?: boolean; exposure?: string }>;
		};
		expect(written.mcpServers.filesystem).toMatchObject({ enabled: false, exposure: "direct" });
		await runtime.service.removeMcpServer("filesystem", BACKGROUND_CONTEXT);
		expect(runtime.service.state.value.mcp.servers).toEqual([]);
		await expect(readFile(join(agentDir, "mcp.json"), "utf8")).resolves.toContain("{}");
	});

	test("rejects invalid JSON, a conflicting namespace, and an unknown server", async () => {
		const { runtime } = await service();
		await expect(runtime.service.addMcpServer("docs", "{not json", BACKGROUND_CONTEXT)).rejects.toThrow(
			/not valid JSON/,
		);
		await expect(runtime.service.addMcpServer("docs", JSON.stringify({}), BACKGROUND_CONTEXT)).rejects.toThrow(
			/needs either "command"/,
		);
		await runtime.service.addMcpServer("my-tools", JSON.stringify({ url: "https://example.com/mcp" }), BACKGROUND_CONTEXT);
		await expect(
			runtime.service.addMcpServer("my_tools", JSON.stringify({ url: "https://example.com/mcp" }), BACKGROUND_CONTEXT),
		).rejects.toThrow(/conflicts/);
		await expect(runtime.service.setMcpServer("nope", { enabled: true }, BACKGROUND_CONTEXT)).rejects.toThrow(
			/Unknown MCP server/,
		);
		await expect(runtime.service.removeMcpServer("nope", BACKGROUND_CONTEXT)).rejects.toThrow(/Unknown MCP server/);
	});

	test("replaces the plugin package default and rejects one the host cannot build", async () => {
		const { runtime, selected } = await service(["/tmp/first-plugin"]);
		expect(runtime.service.state.value.packages).toEqual(["/tmp/first-plugin"]);
		await runtime.service.setPackages(["/tmp/first-plugin", "/tmp/second-plugin"], BACKGROUND_CONTEXT);
		expect(selected).toEqual([["/tmp/first-plugin", "/tmp/second-plugin"]]);
		expect(runtime.service.state.value.packages).toEqual(["/tmp/first-plugin", "/tmp/second-plugin"]);
		await expect(
			runtime.service.setPackages(["/tmp/unbuildable-plugin"], BACKGROUND_CONTEXT),
		).rejects.toThrow(/does not build/);
		// A rejected set leaves the previous selection in place.
		expect(runtime.service.state.value.packages).toEqual(["/tmp/first-plugin", "/tmp/second-plugin"]);
	});

	test("reports a project-scoped server when the project is trusted", async () => {
		const { runtime, cwd } = await service();
		await mkdir(join(cwd, ".amazme"), { recursive: true });
		await writeFile(
			join(cwd, ".amazme", "mcp.json"),
			JSON.stringify({ mcpServers: { local: { url: "https://local.example/mcp" } } }),
			"utf8",
		);
		await runtime.service.reload(BACKGROUND_CONTEXT);
		const servers = runtime.service.state.value.mcp.servers;
		expect(servers).toHaveLength(1);
		expect(servers[0]).toMatchObject({ name: "local", scope: "project", detail: "https://local.example/mcp" });
		expect(runtime.service.state.value.mcp.projectPath).toBe(join(cwd, ".amazme", "mcp.json"));
	});
});
