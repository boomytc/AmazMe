/**
 * @vitest-environment happy-dom
 */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { buildWebView, type WebViewInput } from "../src/view.ts";

function shell(): WebViewInput {
	return {
		locale: "en",
		submitMode: "followUp",
		attachments: [],
		rosterFilter: "",
		approvals: undefined,
		feedback: undefined,
		showWelcome: false,
		focus: undefined,
		history: [],
		historyMore: false,
		historyLoading: false,
		draft: "",
		commands: [],
		completions: [],
		paletteSelection: 0,
		platform: "",
		dock: { open: false, tab: "files", cwd: "", workspace: undefined, terminal: undefined, conversations: undefined },
		panel: { locale: "en", current: "chat" },
		directory: undefined,
		transcript: undefined,
		attachedId: undefined,
		now: 0,
		models: undefined,
		thinkingLevels: [],
	};
}

let handler: ((action: "new-session" | "settings") => void) | undefined;

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
	document.body.innerHTML = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
	handler = undefined;
	window.amazmeDesktop = {
		pickDirectories: async () => [],
		onMenuAction: (listener) => {
			handler = listener;
		},
	};
});

afterEach(() => {
	delete window.amazmeDesktop;
});

describe("desktop menu actions", () => {
	test("reuse the shortcut and settings entry points", () => {
		const renderer = createRenderer(collectPageElements());
		renderer.render(buildWebView(shell()));
		const shortcut = vi.fn();
		renderer.onShortcut = shortcut;
		const action = vi.fn();
		renderer.onPanelAction = action;

		handler?.("new-session");
		expect(shortcut).toHaveBeenCalledWith("session.new");

		handler?.("settings");
		expect(action).toHaveBeenCalledWith({ kind: "open", panel: "settings" });
	});
});
