import { Container, getKeybindings, setKeybindings, TuiAltScreen } from "@amazme/tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveComposer, promptShortcutLine, turnCancelHint, turnCancelNotice } from "../src/modes/interactive/composer-contract.ts";
import { RetryStatusIndicator, WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { expandedStartupHints } from "../src/modes/interactive/startup-hints.ts";
import { getEditorTheme, getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const strip = (text: string) => stripAnsi(text);

function renderHotkeys(): string {
	const chat = new Container();
	const markdownTheme = getMarkdownTheme();
	const keybindings = new KeybindingsManager();
	const mode = {
		chatContainer: chat,
		ui: { requestRender() {} },
		keybindings,
		session: { extensionRunner: { getShortcuts: () => new Map() } },
		getEditorKeyDisplay: Reflect.get(InteractiveMode.prototype, "getEditorKeyDisplay"),
		getAppKeyDisplay: Reflect.get(InteractiveMode.prototype, "getAppKeyDisplay"),
		getMarkdownThemeWithSettings: () => markdownTheme,
	};
	const handleHotkeys = Reflect.get(InteractiveMode.prototype, "handleHotkeysCommand") as () => void;
	handleHotkeys.call(mode);
	return chat.render(140).map(strip).join("\n");
}

describe("chrome copy", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		vi.useRealTimers();
	});

	test("the cancel chord is spelled the same in the indicator, the shortcut bar, and the Esc notice", () => {
		// One source: the composer contract spells the cancel chord for every surface.
		expect(turnCancelHint()).toBe("Ctrl+C to cancel");
		expect(turnCancelNotice()).toBe("Press Ctrl+C to cancel the turn");

		const state = {
			draft: "",
			queue: [],
			turnRunning: true,
			multiline: false,
			terminalClass: "default" as const,
			autocompleteOpen: false,
		};
		const shortcutLine = strip(promptShortcutLine(state));
		expect(shortcutLine).toContain("Ctrl+C:cancel");
		expect(shortcutLine).not.toContain("Esc:cancel");

		const hotkeys = renderHotkeys();
		// Escape closes menus; cancelling a running turn is Ctrl+C.
		expect(hotkeys).toContain("Close autocomplete and overlays");
		expect(hotkeys).not.toContain("abort streaming");
		expect(hotkeys).toContain("twice in a row exits");
	});

	test("the retry countdown advertises Escape and the key really reaches it", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as never;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 5000);
		const rendered = indicator.render(80).map(strip).join("\n");
		expect(rendered).toContain("Escape to cancel");

		// A countdown owns Escape, so the composer hands the key through instead of
		// showing the cancel hint.
		const tuiScreen = new TuiAltScreen(new VirtualTerminal());
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(tuiScreen, getEditorTheme(), keybindings);
		const hints: string[] = [];
		let retryCancelled = 0;
		let ownsEscape = true;
		const composer = new InteractiveComposer(editor, {
			isTurnRunning: () => true,
			send: () => {},
			queue: () => {},
			sendQueued: () => {},
			cancelAndSend: () => {},
			cancelTurn: () => {},
			showEscHint: () => hints.push("hint"),
			background: () => false,
			escOwnedBySurface: () => ownsEscape,
		});
		editor.onEscape = () => {
			retryCancelled += 1;
		};
		editor.onBeforeInput = (data) => composer.handleInput(data);
		try {
			editor.handleInput("\x1b");
			expect(retryCancelled).toBe(1);
			expect(hints).toEqual([]);

			ownsEscape = false;
			editor.handleInput("\x1b");
			expect(retryCancelled).toBe(1);
			expect(hints).toEqual(["hint"]);
		} finally {
			indicator.dispose();
			setKeybindings(new KeybindingsManager());
		}
	});

	test("the working indicator tells the user to cancel with Ctrl+C", () => {
		initTheme("dark");
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as never;
		const indicator = new WorkingStatusIndicator(tui, `Working (${turnCancelHint()})`);
		const rendered = indicator.render(60).map(strip).join("\n");
		expect(rendered).toContain("Ctrl+C to cancel");
		expect(rendered).not.toContain("escape");
		indicator.dispose();
	});

	test("startup hints and /hotkeys spell keys the same way", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const startup = strip(expandedStartupHints({ keybindings, showDetails: false }));
		const hotkeys = renderHotkeys();

		for (const hint of [startup, hotkeys]) {
			expect(hint).toContain("Ctrl+O");
			expect(hint).toContain("Ctrl+G");
		}
		// Escape closes menus and the header no longer promises it interrupts the turn.
		expect(startup).toContain("Escape to close menus");
		expect(startup).not.toContain("to interrupt");
		expect(startup).toContain("Ctrl+C to clear the draft or cancel");
		// Lowercase key spelling is gone from the user-visible chrome.
		expect(startup).not.toContain("ctrl+");
		expect(hotkeys).not.toContain("ctrl+");
		expect(theme.getFgAnsi("dim")).toBeTruthy();
		expect(getKeybindings().getKeys("app.tasks.toggle")).toEqual(["f2"]);
	});
});
