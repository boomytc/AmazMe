/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { buildWebView } from "../src/view.ts";
import type { WebViewInput } from "../src/view.ts";

function input(archived: boolean): WebViewInput {
	return {
		locale: "zh", submitMode: "followUp", attachments: [], rosterFilter: "", approvals: undefined,
		feedback: undefined, showWelcome: false, focus: undefined, history: [], historyMore: false,
		historyLoading: false, draft: "", commands: [], completions: [], paletteSelection: 0, platform: "",
		directory: { sessions: [{ sessionId: "archived-session", createdAt: 1, cwd: "/work", ...(archived ? { archivedAt: 2 } : {}) }] },
		attachedId: "archived-session", showArchived: archived, transcript: undefined, now: 3,
		models: undefined, thinkingLevels: [], panel: { locale: "zh", current: "chat" },
		dock: { open: true, tab: "terminal", cwd: "/work", workspace: undefined, conversations: undefined,
			terminal: { status: "idle", command: null, exitCode: null, output: "", truncated: false, error: null } },
	};
}

test("every archived session is read-only, including old archives without an end-work marker", () => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
	const elements = collectPageElements();
	const renderer = createRenderer(elements);
	const archived = buildWebView(input(true));
	expect(archived.readOnly).toBe(true);
	expect(archived.lane).toBe("已归档 · 恢复后可继续");
	expect(archived.run.compact.disabled).toBe(true);
	expect(archived.run.fork.disabled).toBe(true);
	expect(archived.dock.panel.inputs?.[0]?.submit.disabled).toBe(true);
	renderer.render(archived);
	expect(elements.prompt.disabled).toBe(true);

	const restored = buildWebView(input(false));
	expect(restored.readOnly).toBeUndefined();
	expect(restored.lane).toBe("");
	expect(restored.run.compact.disabled).toBe(false);
	expect(restored.dock.panel.inputs?.[0]?.submit.disabled).toBe(false);
	renderer.render(restored);
	expect(elements.prompt.disabled).toBe(false);
});
