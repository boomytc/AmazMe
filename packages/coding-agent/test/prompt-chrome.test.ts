import { Editor, getKeybindings, SelectList, setKeybindings, TuiMainScreen } from "@amazme/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { promptOwnsKey } from "../src/modes/interactive/interactive-input.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const SUPER_BACKSPACE = "\x1b[27;9;127~";
const SHIFT_RIGHT = "\x1b[1;2C";

describe("prompt chrome", () => {
	beforeAll(() => initTheme("dark"));

	test("the composer is a rounded box with a prompt and the model on the bottom edge", () => {
		const ui = new TuiMainScreen(new VirtualTerminal());
		const editor = new CustomEditor(ui, getEditorTheme(), new KeybindingsManager());
		editor.setModelLabel(() => "model-x · high");
		editor.setText("hello");
		const rendered = editor.render(80).join("\n");
		expect(rendered).toContain("╭");
		expect(rendered).toContain("╮");
		expect(rendered).toContain("> ");
		expect(rendered).toContain("hello");
		expect(rendered).toContain("model-x · high");
		expect(rendered).toContain("Tab");
		expect(rendered).toContain("complete");
	});

	test("a slash menu highlights the selected command and its description", () => {
		const list = new SelectList(
			[
				{ value: "/memory", label: "/memory", description: "Browse memories" },
				{ value: "/goal", label: "/goal", description: "Set a goal" },
			],
			5,
			{
				selectedPrefix: (text: string) => text,
				selectedText: (text: string) => text,
				description: (text: string) => text,
				scrollInfo: (text: string) => text,
				noMatch: (text: string) => text,
			},
			{ highlightSelected: true, minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 20 },
		);
		const lines = list.render(60);
		expect(lines[0]).toContain("/memory");
		expect(lines[0]).toContain("Browse memories");
		expect(lines[0]).toContain("\x1b[7m");
		expect(lines[0]).not.toContain("→");
		expect(lines[1]).toContain("/goal");
		expect(lines[1]).not.toContain("\x1b[7m");
	});

	test("cmd+backspace deletes the whole line and a selection is copied", () => {
		setKeybindings(getKeybindings());
		const ui = new TuiMainScreen(new VirtualTerminal());
		const editor = new Editor(ui, defaultEditorTheme);
		const copied: string[] = [];
		editor.onCopySelection = (text) => copied.push(text);
		editor.setText("delete me");
		editor.handleInput(SUPER_BACKSPACE);
		expect(editor.getText()).toBe("");

		editor.setText("abcd");
		editor.handleInput("\x01");
		editor.handleInput(SHIFT_RIGHT);
		editor.handleInput(SHIFT_RIGHT);
		expect(copied.at(-1)).toBe("ab");
	});

	test("tab belongs to the completion menu while it is open", () => {
		expect(promptOwnsKey("\t", true)).toBe(true);
		expect(promptOwnsKey("\t", false)).toBe(false);
		expect(promptOwnsKey("\x1b[A", true)).toBe(true);
		expect(promptOwnsKey("\x1b[A", false)).toBe(false);
	});
});
