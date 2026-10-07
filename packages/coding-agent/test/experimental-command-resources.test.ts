import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	commandCatalog,
	type CommandResourceSettings,
	expandResourceCommand,
	loadCommandResources,
} from "../src/experimental/services/commands-provider.ts";

let root: string;
let agentDir: string;
let cwd: string;
let previousAgentDir: string | undefined;

const settings: CommandResourceSettings = {
	getPromptTemplatePaths: () => [],
	getSkillPaths: () => [],
	getEnableSkillCommands: () => true,
	reload: async () => undefined,
};

async function writeSkill(name: string, description: string, body: string): Promise<void> {
	const directory = join(agentDir, "skills", name);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
		"utf8",
	);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "amazme-commands-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	await mkdir(join(agentDir, "prompts"), { recursive: true });
	await mkdir(join(cwd, ".amazme", "prompts"), { recursive: true });
	previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
});

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	await rm(root, { recursive: true, force: true });
});

describe("the session's command catalogue", () => {
	test("lists the host's own commands, the session's templates, and its skills", async () => {
		await writeFile(
			join(agentDir, "prompts", "weekly-report.md"),
			"---\ndescription: Draft the weekly report\nargument-hint: <week>\n---\n\nReport for $1.\n",
			"utf8",
		);
		await writeFile(join(cwd, ".amazme", "prompts", "triage.md"), "Sort the inbox.\n", "utf8");
		await writeSkill("draft-brief", "Draft a brief", "Write the brief.");

		const catalog = commandCatalog(loadCommandResources({ cwd, settings }));
		const runnable = catalog.filter((command) => command.availability === "all");
		expect(runnable.map((command) => [command.name, command.source])).toEqual([
			["model", "builtin"],
			["thinking", "builtin"],
			["compact", "builtin"],
			["reload", "builtin"],
			["weekly-report", "template"],
			["triage", "template"],
			["skill:draft-brief", "skill"],
		]);
		// A template's description and argument hint reach the palette from its frontmatter.
		expect(catalog.find((command) => command.name === "weekly-report")).toEqual({
			name: "weekly-report",
			description: "Draft the weekly report",
			argumentHint: "<week>",
			source: "template",
			availability: "all",
		});
		// Without a description the first line of the body stands in, as the terminal's loader does.
		expect(catalog.find((command) => command.name === "triage")?.description).toBe("Sort the inbox.");
		expect(catalog.find((command) => command.name === "skill:draft-brief")?.argumentHint).toBe("[args]");
	});

	test("marks the terminal's own commands and shadows their names with the host's", () => {
		const catalog = commandCatalog(loadCommandResources({ cwd, settings }), [
			{ name: "hello", description: "Say hello", argumentHint: "<who>" },
		]);
		// What this host runs, what it expands, and what a plugin registered: runnable everywhere.
		expect(catalog.find((command) => command.name === "model")).toMatchObject({
			source: "builtin",
			availability: "all",
		});
		expect(catalog.find((command) => command.name === "hello")).toMatchObject({
			source: "plugin",
			availability: "all",
		});
		// The terminal's own commands are listed once, after everything runnable, and marked.
		expect(catalog.find((command) => command.name === "export")).toMatchObject({
			source: "builtin",
			availability: "terminal",
		});
		expect(catalog.filter((command) => command.name === "model")).toHaveLength(1);
		const runnable = catalog.filter((command) => command.availability === "all").length;
		expect(catalog.slice(runnable).every((command) => command.availability === "terminal")).toBe(true);
		expect(catalog.some((command) => command.name === "quit")).toBe(true);
	});

	test("leaves skills out when the skill-command switch is off", async () => {
		await writeSkill("draft-brief", "Draft a brief", "Write the brief.");
		const disabled: CommandResourceSettings = { ...settings, getEnableSkillCommands: () => false };
		const catalog = commandCatalog(loadCommandResources({ cwd, settings: disabled }));
		expect(catalog.some((command) => command.source === "skill")).toBe(false);
		// The switch is what withholds them: the same session offers the skill when it is on.
		expect(commandCatalog(loadCommandResources({ cwd, settings })).some((c) => c.source === "skill")).toBe(true);
	});
});

describe("expanding a resource command", () => {
	test("substitutes a template's arguments the way the terminal does", async () => {
		await writeFile(
			join(agentDir, "prompts", "weekly-report.md"),
			"---\ndescription: Draft the weekly report\n---\n\nReport for $1 (all: $ARGUMENTS).\n",
			"utf8",
		);
		const resources = loadCommandResources({ cwd, settings });
		expect(expandResourceCommand(resources, "weekly-report", "w34")).toEqual({
			ok: true,
			prompt: "Report for w34 (all: w34).",
		});
		expect(expandResourceCommand(resources, "weekly-report", '"two words" second')).toEqual({
			ok: true,
			prompt: "Report for two words (all: two words second).",
		});
		// An argument-less invocation still expands, with the missing values empty.
		expect(expandResourceCommand(resources, "weekly-report", "")).toEqual({
			ok: true,
			prompt: "Report for  (all: ).",
		});
	});

	test("expands a skill into the block the terminal sends", async () => {
		await writeSkill("draft-brief", "Draft a brief", "# Steps\n\nWrite it.");
		const resources = loadCommandResources({ cwd, settings });
		const expected = `<skill name="draft-brief" location="${join(agentDir, "skills", "draft-brief", "SKILL.md")}">\nReferences are relative to ${join(agentDir, "skills", "draft-brief")}.\n\n# Steps\n\nWrite it.\n</skill>`;
		expect(expandResourceCommand(resources, "skill:draft-brief", "")).toEqual({ ok: true, prompt: expected });
		expect(expandResourceCommand(resources, "skill:draft-brief", "  this week  ")).toEqual({
			ok: true,
			prompt: `${expected}\n\nthis week`,
		});
	});

	test("refuses a name that is not a command, and a skill whose file is gone", async () => {
		await writeSkill("draft-brief", "Draft a brief", "Write the brief.");
		const resources = loadCommandResources({ cwd, settings });
		expect(expandResourceCommand(resources, "model", "")).toEqual({ ok: false, problem: "Unknown command: /model" });
		expect(expandResourceCommand(resources, "nope", "")).toEqual({ ok: false, problem: "Unknown command: /nope" });
		await rm(join(agentDir, "skills", "draft-brief", "SKILL.md"));
		const gone = expandResourceCommand(resources, "skill:draft-brief", "");
		expect(gone.ok).toBe(false);
		expect(gone.ok ? "" : gone.problem).toContain("SKILL.md");
	});
});
