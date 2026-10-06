import { describe, expect, it } from "vitest";
import type { KeyId } from "@amazme/tui";
import {
	getClipboardPasteKeys,
	KEYBINDINGS,
	KeybindingsManager,
	useWindowsKeybindings,
} from "../src/core/keybindings.ts";

describe("Windows keybinding defaults", () => {
	it("uses Windows keybindings on native Windows", () => {
		expect(useWindowsKeybindings("win32", {})).toBe(true);
	});

	it("uses Windows keybindings in WSL without relying on Windows Terminal detection", () => {
		expect(useWindowsKeybindings("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
		expect(useWindowsKeybindings("linux", { WSL_INTEROP: "/run/WSL/123_interop" })).toBe(true);
	});

	it("does not use Windows keybindings from WT_SESSION alone", () => {
		expect(useWindowsKeybindings("linux", { WT_SESSION: "session" })).toBe(false);
	});

	it("keeps non-Windows defaults on other platforms", () => {
		expect(useWindowsKeybindings("linux", {})).toBe(false);
		expect(useWindowsKeybindings("darwin", {})).toBe(false);
	});

	it("applies the detected defaults consistently", () => {
		const windowsKeybindings = useWindowsKeybindings();
		const nativeWindows = process.platform === "win32";

		expect(KEYBINDINGS["app.clipboard.pasteImage"].defaultKeys).toEqual(getClipboardPasteKeys());
		expect(KEYBINDINGS["tui.altScreen.search"].defaultKeys).toEqual(
			windowsKeybindings ? ["ctrl+f", "f3"] : ["ctrl+shift+f", "f3"],
		);
		expect(KEYBINDINGS["app.message.followUp"].defaultKeys).toBe(windowsKeybindings ? "ctrl+q" : "alt+enter");
		expect(KEYBINDINGS["app.model.cycleBackward"].defaultKeys).toBe(windowsKeybindings ? "alt+p" : "shift+ctrl+p");
		expect(KEYBINDINGS["tui.editor.undo"].defaultKeys).toBe(
			nativeWindows ? "ctrl+z" : windowsKeybindings ? "alt+z" : "ctrl+-",
		);
		expect(KEYBINDINGS["tui.altScreen.previousPrompt"].defaultKeys).toEqual(
			windowsKeybindings ? "ctrl+up" : ["ctrl+shift+up", "ctrl+up"],
		);
		expect(KEYBINDINGS["tui.altScreen.nextPrompt"].defaultKeys).toEqual(
			windowsKeybindings ? "ctrl+down" : ["ctrl+shift+down", "ctrl+down"],
		);
		expect(KEYBINDINGS["app.message.dequeue"].defaultKeys).toBe(windowsKeybindings ? "alt+q" : "alt+up");
	});
});

describe("system clipboard paste defaults", () => {
	it.each<{ platform: NodeJS.Platform; env: NodeJS.ProcessEnv; keys: KeyId[]; events: string[] }>([
		{ platform: "darwin", env: {}, keys: ["super+v", "ctrl+v"], events: ["\x1b[118;9u", "\x16"] },
		{ platform: "win32", env: {}, keys: ["ctrl+v", "alt+v"], events: ["\x16", "\x1bv"] },
		{ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, keys: ["ctrl+v", "alt+v"], events: ["\x16", "\x1bv"] },
		{
			platform: "linux",
			env: { WSL_INTEROP: "/run/WSL/123_interop" },
			keys: ["ctrl+v", "alt+v"],
			events: ["\x16", "\x1bv"],
		},
		{
			platform: "linux",
			env: { WT_SESSION: "session" },
			keys: ["ctrl+shift+v", "ctrl+v"],
			events: ["\x1b[118;6u", "\x16"],
		},
	])("accepts the primary and fallback on $platform with $env", ({ platform, env, keys, events }) => {
		const defaults = getClipboardPasteKeys(platform, env);
		expect(defaults).toEqual(keys);
		const bindings = new KeybindingsManager({ "app.clipboard.pasteImage": defaults });
		for (const event of events) expect(bindings.matches(event, "app.clipboard.pasteImage")).toBe(true);
	});

	it("custom paste bindings replace every system default", () => {
		const bindings = new KeybindingsManager({ "app.clipboard.pasteImage": "ctrl+shift+x" });
		for (const event of ["\x1b[118;9u", "\x16", "\x1bv", "\x1b[118;6u"]) {
			expect(bindings.matches(event, "app.clipboard.pasteImage")).toBe(false);
		}
		expect(bindings.matches("\x1b[120;6u", "app.clipboard.pasteImage")).toBe(true);
	});
});
