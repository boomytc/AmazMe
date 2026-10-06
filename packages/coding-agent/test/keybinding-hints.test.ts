import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@amazme/tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getClipboardPasteKeys, KeybindingsManager } from "../src/core/keybindings.ts";
import {
	clipboardPasteFallbackText,
	formatKeyText,
	keyDisplayText,
	keyHint,
} from "../src/modes/interactive/components/keybinding-hints.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const previous = getKeybindings();
beforeEach(() => initTheme("dark", false));
afterEach(() => setKeybindings(previous));

describe("system key names", () => {
	it.each<{ platform: NodeJS.Platform; env: NodeJS.ProcessEnv; expected: string }>([
		{ platform: "darwin", env: {}, expected: "Cmd+V/Option+Enter/Ctrl+V" },
		{ platform: "win32", env: {}, expected: "Win+V/Alt+Enter/Ctrl+V" },
		{ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, expected: "Win+V/Alt+Enter/Ctrl+V" },
		{ platform: "linux", env: {}, expected: "Super+V/Alt+Enter/Ctrl+V" },
	])("uses $platform names with $env", ({ platform, env, expected }) => {
		expect(formatKeyText("super+v/alt+enter/ctrl+v", { platform, env, capitalize: true })).toBe(expected);
	});

	it("keeps modifier combinations and lowercase hints consistent", () => {
		expect(formatKeyText("ctrl+super+alt+k", { platform: "darwin", env: {} })).toBe("ctrl+cmd+option+k");
	});
});

describe("clipboard key hints", () => {
	it.each<{ platform: NodeJS.Platform; env: NodeJS.ProcessEnv; primary: string; fallback: string }>([
		{ platform: "darwin", env: {}, primary: "Cmd+V", fallback: "Ctrl+V" },
		{ platform: "win32", env: {}, primary: "Ctrl+V", fallback: "Alt+V" },
		{ platform: "linux", env: { WSL_INTEROP: "/run/WSL/123_interop" }, primary: "Ctrl+V", fallback: "Alt+V" },
		{ platform: "linux", env: {}, primary: "Ctrl+Shift+V", fallback: "Ctrl+V" },
	])("shows the enabled fallback on $platform", ({ platform, env, primary, fallback }) => {
		const bindings = new KeybindingsManager({ "app.clipboard.pasteImage": getClipboardPasteKeys(platform, env) });
		expect(clipboardPasteFallbackText(bindings, { platform, env })).toBe(
			`${primary} supports terminal image paste; ${fallback} also reads the clipboard directly.`,
		);
	});

	it("follows custom bindings and disabled actions without showing stale defaults", () => {
		const bindings = new KeybindingsManager();
		setKeybindings(bindings);
		bindings.setUserBindings({ "app.clipboard.pasteImage": "ctrl+shift+x" });
		expect(keyDisplayText("app.clipboard.pasteImage")).toBe("Ctrl+Shift+X");
		expect(stripVTControlCharacters(keyHint("app.clipboard.pasteImage", "paste image"))).toBe(
			"ctrl+shift+x paste image",
		);
		expect(clipboardPasteFallbackText(bindings)).toBeUndefined();
		bindings.setUserBindings({ "app.clipboard.pasteImage": [] });
		expect(keyDisplayText("app.clipboard.pasteImage")).toBe("");
		expect(keyHint("app.clipboard.pasteImage", "paste image")).toBe("");
		expect(clipboardPasteFallbackText(bindings)).toBeUndefined();
	});

	it("does not advertise a fallback that was removed", () => {
		const bindings = new KeybindingsManager({ "app.clipboard.pasteImage": "super+v" });
		expect(clipboardPasteFallbackText(bindings, { platform: "darwin", env: {} })).toBeUndefined();
	});
});
