import { Container, getKeybindings, setKeybindings, setKittyProtocolActive, Text } from "@amazme/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createInteractiveTui } from "../src/modes/interactive/tui-renderer.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

/** A terminal without the Kitty keyboard protocol, where Ctrl+Shift+F never arrives. */
class LegacyTerminal extends VirtualTerminal {
	override get kittyProtocolActive(): boolean {
		return false;
	}
}

describe("transcript search entry", () => {
	beforeAll(() => initTheme("dark"));

	test("F3 opens the transcript search on a terminal without the Kitty protocol", async () => {
		const previous = getKeybindings();
		setKeybindings(new KeybindingsManager());
		setKittyProtocolActive(false);
		const terminal = new LegacyTerminal(80, 10);
		const tui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		try {
			tui.addChild(new Text("needle one\nmiddle\nneedle two", 0, 0));
			tui.start();
			await terminal.waitForRender();

			// A terminal that cannot deliver Ctrl+Shift+F sends Ctrl+F, which must not open search.
			terminal.sendInput("\x06");
			await terminal.waitForRender();
			expect(tui.searchOpen).toBe(false);

			terminal.sendInput("\x1bOR");
			await terminal.waitForRender();
			expect(tui.searchOpen).toBe(true);
			expect(terminal.getViewport().some((line) => line.includes("Find in transcript"))).toBe(true);

			terminal.sendInput("needle");
			await terminal.waitForRender();
			expect(terminal.getViewport().some((line) => line.includes("1/2"))).toBe(true);

			// Search next stays inside the new entry.
			terminal.sendInput("\r");
			await terminal.waitForRender();
			expect(terminal.getViewport().some((line) => line.includes("2/2"))).toBe(true);

			terminal.sendInput("\x1b");
			await terminal.waitForRender();
			expect(tui.searchOpen).toBe(false);
		} finally {
			tui.stop();
			setKittyProtocolActive(true);
			setKeybindings(previous);
		}
	});

	test("the slash menu offers /find and the command opens the same search box", async () => {
		const previous = getKeybindings();
		setKeybindings(new KeybindingsManager());
		const terminal = new LegacyTerminal(80, 10);
		const tui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const statuses: string[] = [];
		const handler = Reflect.get(InteractiveMode.prototype, "handleFindCommand") as () => void;
		try {
			expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "find")).toBe(true);

			handler.call({ renderer: tui, showStatus: (message: string) => statuses.push(message) });
			expect(tui.searchOpen).toBe(true);
			expect(statuses).toEqual([]);

			// Regular mode has no search box, so the command points at the terminal instead.
			handler.call({ renderer: {}, showStatus: (message: string) => statuses.push(message) });
			expect(statuses).toHaveLength(1);
			expect(statuses[0]).toContain("fullscreen");
		} finally {
			tui.stop();
			setKeybindings(previous);
		}
	});

	test("the default search chord offers an F3 fallback and /hotkeys lists it", async () => {
		const previous = getKeybindings();
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		try {
			expect(getKeybindings().getKeys("tui.altScreen.search")).toContain("f3");

			const chat = new Container();
			const markdownTheme = getMarkdownTheme();
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
			const rendered = chat
				.render(120)
				.join("\n")
				.replace(/\x1b\[[0-9;]*m/g, "");
			expect(rendered).toContain("Search the rendered transcript");
			expect(rendered).toContain("F3");
		} finally {
			setKeybindings(previous);
		}
	});
});
