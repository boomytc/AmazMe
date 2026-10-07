import { describe, expect, test } from "vitest";
import { commandPalette, parseCommandLine } from "../src/commands.ts";
import { gestureKeys, isApplePlatform, matchShortcut, shortcuts, STOP_SEQUENCE_MS } from "../src/shortcuts.ts";

const COMMANDS = [
	{ name: "model", description: "Select the model", argumentHint: "<provider/model>", source: "builtin" as const },
	{ name: "thinking", description: "Set the reasoning level", argumentHint: "<level>", source: "builtin" as const },
	{ name: "compact", description: "Summarize the conversation so far", argumentHint: "[instructions]", source: "builtin" as const },
];

describe("command lines", () => {
	test("parses a bare name and a name with arguments", () => {
		expect(parseCommandLine("/model")).toEqual({ name: "model", args: "" });
		expect(parseCommandLine("/model kimi-coding/kimi-for-coding")).toEqual({
			name: "model",
			args: "kimi-coding/kimi-for-coding",
		});
		expect(parseCommandLine("/model  two  spaces")).toEqual({ name: "model", args: " two  spaces" });
		// A plain prompt, a lone slash, and a non-command are not command lines.
		expect(parseCommandLine("hello /model")).toBeUndefined();
		expect(parseCommandLine("/")).toBeUndefined();
		expect(parseCommandLine("/Model")).toBeUndefined();
	});

	test("filters the catalogue, then completes the argument", () => {
		const byName = commandPalette("en", { draft: "/mo", commands: COMMANDS });
		expect(byName.open).toBe(true);
		expect(byName.rows.map((row) => [row.value, row.label, row.hint, row.selected])).toEqual([
			["model", "/model", "<provider/model>", true],
		]);

		const completions = commandPalette("en", {
			draft: "/model kimi",
			commands: COMMANDS,
			completions: [
				{ value: "kimi-coding/kimi-for-coding", label: "kimi-for-coding", description: "kimi-coding" },
				{ value: "kimi-coding/kimi-k2", label: "kimi-k2", description: "kimi-coding" },
			],
			selected: 1,
		});
		expect(completions.rows.map((row) => [row.value, row.selected])).toEqual([
			["kimi-coding/kimi-for-coding", false],
			["kimi-coding/kimi-k2", true],
		]);
	});

	test("lists every command for a bare slash, and nothing for a name that is not one", () => {
		const bare = commandPalette("en", { draft: "/", commands: COMMANDS });
		expect(bare.open).toBe(true);
		expect(bare.rows.map((row) => row.value)).toEqual(["model", "thinking", "compact"]);
		// A capital is not a command name, so the palette stays closed and the text is just a prompt.
		expect(commandPalette("en", { draft: "/Model", commands: COMMANDS }).open).toBe(false);
		// The runnable parse still refuses the bare slash: it is the focus shortcut, not a command.
		expect(parseCommandLine("/")).toBeUndefined();
	});

	test("says why it is empty and stays closed for a plain prompt", () => {
		expect(commandPalette("en", { draft: "/nope", commands: COMMANDS }).empty).toBe(
			"No command starts with that.",
		);
		expect(commandPalette("en", { draft: "/model x", commands: COMMANDS }).empty).toBe(
			"Nothing to complete here.",
		);
		expect(commandPalette("en", { draft: "just a prompt", commands: COMMANDS }).open).toBe(false);
		expect(commandPalette("zh", { draft: "/mo", commands: COMMANDS }).title).toBe("命令");
	});

	test("marks a command only the terminal can run, and tags a plugin's", () => {
		const commands = [
			...COMMANDS,
			{ name: "hello", description: "Say hello", argumentHint: "<who>", source: "plugin" as const },
			{ name: "export", description: "Export the session", source: "builtin" as const, availability: "terminal" as const },
		];
		const palette = commandPalette("en", { draft: "/", commands });
		const plugin = palette.rows.find((row) => row.value === "hello");
		const terminalOnly = palette.rows.find((row) => row.value === "export");
		expect(plugin?.tag).toBe("plugin");
		expect(plugin?.disabled).toBeUndefined();
		// The terminal's own command is listed so the reader is told, and marked unrunnable here.
		expect(terminalOnly).toMatchObject({ tag: "terminal only", disabled: true });
		expect(commandPalette("zh", { draft: "/", commands }).rows.find((row) => row.value === "export")?.tag).toBe(
			"仅终端",
		);
	});

	test("offers the session's resource commands, each tagged with where it came from", () => {
		const commands = [
			...COMMANDS,
			{ name: "weekly-report", description: "Draft the report", source: "template" as const },
			{ name: "skill:draft-brief", description: "Draft a brief", argumentHint: "[args]", source: "skill" as const },
		];
		const palette = commandPalette("en", { draft: "/", commands });
		expect(palette.rows.map((row) => [row.label, row.tag])).toEqual([
			["/model", undefined],
			["/thinking", undefined],
			["/compact", undefined],
			["/weekly-report", "template"],
			["/skill:draft-brief", "skill"],
		]);
		const skills = commandPalette("en", { draft: "/skill:d", commands });
		expect(skills.rows.map((row) => row.label)).toEqual(["/skill:draft-brief"]);
		// The tags are the reader's language.
		expect(commandPalette("zh", { draft: "/", commands }).rows.map((row) => row.tag)).toEqual([
			undefined,
			undefined,
			undefined,
			"模板",
			"技能",
		]);
	});
});

describe("keyboard shortcuts", () => {
	test("matches a gesture only with exactly the modifiers it declares", () => {
		expect(matchShortcut({ code: "KeyN", primary: true, alt: true, shift: false })).toBe("session.new");
		expect(matchShortcut({ code: "KeyM", primary: true, alt: true, shift: false })).toBe("view.cycle");
		expect(matchShortcut({ code: "Slash", primary: false, alt: false, shift: false })).toBe("composer.focus");
		expect(matchShortcut({ code: "Escape", primary: false, alt: false, shift: false })).toBe("run.stop");
		// A browser combination that only looks similar is left to the browser.
		expect(matchShortcut({ code: "KeyN", primary: true, alt: false, shift: false })).toBeUndefined();
		expect(matchShortcut({ code: "KeyM", primary: true, alt: true, shift: true })).toBeUndefined();
		expect(matchShortcut({ code: "KeyM", primary: false, alt: true, shift: false })).toBeUndefined();
	});

	test("writes the keys the way each platform does", () => {
		const mac = shortcuts("en", "MacIntel");
		expect(mac.map((row) => [row.id, row.keys])).toEqual([
			["session.new", "\u2318\u2325N"],
			["view.cycle", "\u2318\u2325M"],
			["composer.focus", "/"],
			["run.stop", "Esc"],
		]);
		expect(shortcuts("en", "Win32").map((row) => row.keys)).toEqual(["Ctrl+Alt+N", "Ctrl+Alt+M", "/", "Esc"]);
		expect(shortcuts("zh", "MacIntel").map((row) => row.label)).toEqual([
			"新建会话",
			"切换管理视图",
			"聚焦输入框",
			"连按两次 Esc 停止回合",
		]);
		expect(gestureKeys({ code: "KeyN", primary: true, alt: true, shift: true }, "Win32")).toBe("Ctrl+Alt+Shift+N");
		expect(isApplePlatform("MacIntel")).toBe(true);
		expect(isApplePlatform("Linux x86_64")).toBe(false);
		expect(STOP_SEQUENCE_MS).toBe(500);
	});
});
