import { stripVTControlCharacters } from "node:util";
import { Container, Editor, getKeybindings, SelectList, setKeybindings, TuiMainScreen, visibleWidth } from "@amazme/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { promptOwnsKey } from "../src/modes/interactive/interactive-input.ts";
import { promptShortcutLine } from "../src/modes/interactive/composer-contract.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const SUPER_BACKSPACE = "\x1b[27;9;127~";
const SHIFT_RIGHT = "\x1b[1;2C";

type PromptShortcutState = Parameters<typeof promptShortcutLine>[0];

const idleState: PromptShortcutState = {
	draft: "",
	queue: [],
	turnRunning: false,
	multiline: false,
	terminalClass: "default",
	autocompleteOpen: false,
};

describe("prompt chrome", () => {
	beforeAll(() => initTheme("dark"));

	test("the composer is a rounded box with a prompt and the model on the bottom edge", () => {
		const ui = new TuiMainScreen(new VirtualTerminal());
		const editor = new CustomEditor(ui, getEditorTheme(), new KeybindingsManager());
		editor.setModelLabel(() => "model-x · high");
		editor.setText("hello");
		const rendered = editor.render(120).join("\n");
		expect(rendered).toContain("╭");
		expect(rendered).toContain("╮");
		expect(rendered).toContain("> ");
		expect(rendered).toContain("hello");
		expect(rendered).toContain("model-x · high");
		expect(stripVTControlCharacters(editor.render(120).at(-1)!)).toBe("Ctrl+\\:dashboard");
		expect(rendered).not.toContain("Cmd+");
	});

	test.each<{ name: string; state: Partial<PromptShortcutState>; expected: string }>([
		{ name: "idle empty prompt", state: {}, expected: "Ctrl+\\:dashboard" },
		{ name: "idle draft", state: { draft: "hello" }, expected: "Ctrl+\\:dashboard" },
		{ name: "idle whitespace", state: { draft: " \n " }, expected: "Ctrl+\\:dashboard" },
		{
			name: "completion menu",
			state: { autocompleteOpen: true },
			expected: "Ctrl+\\:dashboard │ Tab:complete",
		},
		{
			name: "running draft",
			state: { draft: "later", turnRunning: true },
			expected: "Ctrl+\\:dashboard │ Enter:queue │ Ctrl+Enter:now",
		},
		{
			name: "running draft in Apple Terminal with completion and queue",
			state: {
				draft: "later",
				queue: ["first", "second"],
				turnRunning: true,
				terminalClass: "apple-terminal",
				autocompleteOpen: true,
			},
			expected: "Ctrl+\\:dashboard │ Enter:queue │ Ctrl+O:now │ Tab:complete │ Queued: first +1",
		},
		{
			name: "running draft in VS Code",
			state: { draft: "later", turnRunning: true, terminalClass: "vscode" },
			expected: "Ctrl+\\:dashboard │ Enter:queue │ Ctrl+L:now",
		},
		{
			name: "running empty prompt without queued messages",
			state: { turnRunning: true },
			expected: "Ctrl+\\:dashboard │ Ctrl+C:cancel",
		},
		{
			name: "running whitespace without queued messages",
			state: { draft: " \n ", turnRunning: true },
			expected: "Ctrl+\\:dashboard │ Ctrl+C:cancel",
		},
		{
			name: "running empty prompt with queued messages",
			state: { queue: ["first\nrow", "second"], turnRunning: true },
			expected: "Ctrl+\\:dashboard │ Enter:send │ Ctrl+Enter:now │ Ctrl+C:cancel │ Queued: first row +1",
		},
		{
			name: "multiline draft",
			state: { draft: "hello", multiline: true },
			expected: "Ctrl+\\:dashboard │ Enter:newline │ Shift+Enter/Alt+Enter:send",
		},
		{
			name: "multiline empty prompt",
			state: { multiline: true },
			expected: "Ctrl+\\:dashboard │ Enter:newline",
		},
		{
			name: "running multiline draft",
			state: { draft: "hello", multiline: true, turnRunning: true },
			expected: "Ctrl+\\:dashboard │ Enter:newline │ Shift+Enter/Alt+Enter:send │ Ctrl+Enter:now",
		},
		{
			name: "running multiline empty prompt with a queued message",
			state: { multiline: true, turnRunning: true, queue: ["first"] },
			expected: "Ctrl+\\:dashboard │ Enter:send │ Ctrl+Enter:now │ Ctrl+C:cancel │ Queued: first",
		},
		{
			name: "running multiline empty prompt without queued messages",
			state: { multiline: true, turnRunning: true },
			expected: "Ctrl+\\:dashboard │ Enter:newline │ Ctrl+C:cancel",
		},
	])("the shortcut line stays compact for $name", ({ state, expected }) => {
		expect(stripVTControlCharacters(promptShortcutLine({ ...idleState, ...state }))).toBe(expected);
	});

	test("the editor renders state-specific shortcuts without exceeding narrow widths", () => {
		const ui = new TuiMainScreen(new VirtualTerminal());
		const editor = new CustomEditor(ui, getEditorTheme(), new KeybindingsManager());
		const state: PromptShortcutState = { ...idleState, draft: "later", turnRunning: true, queue: ["first", "second"] };
		editor.setText(state.draft);
		editor.setShortcutLine(() => promptShortcutLine(state));
		expect(stripVTControlCharacters(editor.render(120).at(-1)!)).toBe(
			"Ctrl+\\:dashboard │ Enter:queue │ Ctrl+Enter:now │ Queued: first +1",
		);
		for (const width of [8, 20, 40, 80]) {
			for (const line of editor.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		state.turnRunning = false;
		state.queue = [];
		expect(stripVTControlCharacters(editor.render(120).at(-1)!)).toBe("Ctrl+\\:dashboard");
		state.autocompleteOpen = true;
		expect(stripVTControlCharacters(editor.render(120).at(-1)!)).toBe("Ctrl+\\:dashboard │ Tab:complete");
		state.autocompleteOpen = false;
		expect(stripVTControlCharacters(editor.render(120).at(-1)!)).toBe("Ctrl+\\:dashboard");
	});

	test("hotkeys keeps the basic composer controls discoverable", () => {
		const chat = new Container();
		const mode = {
			chatContainer: chat,
			keybindings: new KeybindingsManager(),
			ui: new TuiMainScreen(new VirtualTerminal()),
			session: { extensionRunner: { getShortcuts: () => new Map() } },
			getAppKeyDisplay: Reflect.get(InteractiveMode.prototype, "getAppKeyDisplay") as (action: string) => string,
			getEditorKeyDisplay: Reflect.get(InteractiveMode.prototype, "getEditorKeyDisplay") as (action: string) => string,
			getMarkdownThemeWithSettings: getMarkdownTheme,
		};
		const showHotkeys = Reflect.get(InteractiveMode.prototype, "handleHotkeysCommand") as () => void;
		showHotkeys.call(mode);
		const rendered = stripVTControlCharacters(chat.render(240).join("\n"));
		expect(rendered).toContain("Composer");
		expect(rendered).toContain("Send when idle");
		expect(rendered).toContain("Insert a new line; in multiline mode, send the draft");
		expect(rendered).toContain("Clear the draft");
		expect(rendered).toContain("cancel the running turn");
		expect(rendered).toContain("prompt and scrollback");
		expect(rendered).toContain("Delete to start of line");
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
