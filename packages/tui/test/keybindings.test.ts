import assert from "node:assert";
import { describe, it } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "../src/keybindings.ts";

describe("KeybindingsManager", () => {
	it("binds Ctrl+J as a default newline alias", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		assert.deepStrictEqual(keybindings.getKeys("tui.input.newLine"), ["shift+enter", "ctrl+j"]);
		assert.strictEqual(keybindings.matches("\n", "tui.input.newLine"), true);
		assert.strictEqual(keybindings.matches("\x1b[106;5u", "tui.input.newLine"), true);
	});

	it("binds modified and unmodified editor viewport navigation", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorLineStart"), ["home", "ctrl+a", "super+left"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorLineEnd"), ["end", "ctrl+e", "super+right"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.pageUp"), ["pageUp", "ctrl+pageUp"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.pageDown"), ["pageDown", "ctrl+pageDown"]);
	});

	it("matches Command arrows for line boundaries without matching ordinary or word navigation", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		for (const sequence of ["\x1b[1;9D", "\x1b[1;9:2D", "\x1b[57417;9u"]) {
			assert.strictEqual(keybindings.matches(sequence, "tui.editor.cursorLineStart"), true);
			assert.strictEqual(keybindings.matches(sequence, "tui.editor.cursorLeft"), false);
			assert.strictEqual(keybindings.matches(sequence, "tui.editor.cursorWordLeft"), false);
		}
		for (const sequence of ["\x1b[1;9C", "\x1b[1;9:2C", "\x1b[57418;9u"]) {
			assert.strictEqual(keybindings.matches(sequence, "tui.editor.cursorLineEnd"), true);
			assert.strictEqual(keybindings.matches(sequence, "tui.editor.cursorRight"), false);
			assert.strictEqual(keybindings.matches(sequence, "tui.editor.cursorWordRight"), false);
		}
		assert.strictEqual(keybindings.matches("\x1b[D", "tui.editor.cursorLineStart"), false);
		assert.strictEqual(keybindings.matches("\x1b[1;5D", "tui.editor.cursorLineStart"), false);
		assert.strictEqual(keybindings.matches("\x1b[C", "tui.editor.cursorLineEnd"), false);
		assert.strictEqual(keybindings.matches("\x1b[1;3C", "tui.editor.cursorLineEnd"), false);
	});

	it("lets user bindings replace or disable Command-arrow defaults", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.editor.cursorLineStart": "home",
			"tui.editor.cursorLineEnd": [],
		});

		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorLineStart"), ["home"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorLineEnd"), []);
		assert.strictEqual(keybindings.matches("\x1b[H", "tui.editor.cursorLineStart"), true);
		assert.strictEqual(keybindings.matches("\x1b[1;9D", "tui.editor.cursorLineStart"), false);
		assert.strictEqual(keybindings.matches("\x1b[1;9C", "tui.editor.cursorLineEnd"), false);
	});

	it("leaves dedicated prompt history navigation unbound by default", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		assert.deepStrictEqual(keybindings.getKeys("tui.editor.historyPrevious"), []);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.historyNext"), []);
	});

	it("binds unmodified terminal viewport shortcuts to alternate-screen navigation", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.pageUp"), ["pageUp"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.pageDown"), ["pageDown"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.halfPageUp"), []);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.halfPageDown"), []);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.lineUp"), []);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.lineDown"), []);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.previousPrompt"), ["ctrl+shift+up", "ctrl+up"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.nextPrompt"), ["ctrl+shift+down", "ctrl+down"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.search"), ["ctrl+shift+f"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.searchNext"), ["enter", "ctrl+g"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.searchPrevious"), ["shift+enter", "ctrl+shift+g"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.searchClose"), ["escape"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.top"), ["ctrl+home"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.bottom"), ["ctrl+end"]);
	});

	it("does not evict selector confirm when input submit is rebound", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": ["enter", "ctrl+enter"],
		});

		assert.deepStrictEqual(keybindings.getKeys("tui.input.submit"), ["enter", "ctrl+enter"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.select.confirm"), ["enter"]);
	});

	it("does not evict cursor bindings when another action reuses the same key", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.up": ["up", "ctrl+p"],
		});

		assert.deepStrictEqual(keybindings.getKeys("tui.select.up"), ["up", "ctrl+p"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorUp"), ["up"]);
	});

	it("still reports direct user binding conflicts without evicting defaults", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": "ctrl+x",
			"tui.select.confirm": "ctrl+x",
		});

		assert.deepStrictEqual(keybindings.getConflicts(), [
			{
				key: "ctrl+x",
				keybindings: ["tui.input.submit", "tui.select.confirm"],
			},
		]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorLeft"), ["left", "ctrl+b"]);
	});
});
