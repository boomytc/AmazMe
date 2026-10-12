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
		attachedId: "archived-session", transcript: undefined, now: 3,
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
	expect(archived.archivedAttached?.id).toBe("archived-session");
	expect(archived.roster).toEqual([]);
	expect(archived.empty).toBe("归档会话在设置 → 已归档。");
	expect(archived.lane).toBe("已归档 · 恢复后可继续");
	expect(archived.run.compact.disabled).toBe(true);
	expect(archived.run.fork.disabled).toBe(true);
	expect(archived.dock.panel.inputs?.[0]?.submit.disabled).toBe(true);
	renderer.render(archived);
	expect(elements.prompt.disabled).toBe(true);

	const restored = buildWebView(input(false));
	expect(restored.readOnly).toBeUndefined();
	expect(restored.archivedAttached).toBeUndefined();
	expect(restored.lane).toBe("");
	expect(restored.run.compact.disabled).toBe(false);
	expect(restored.dock.panel.inputs?.[0]?.submit.disabled).toBe(false);
	renderer.render(restored);
	expect(elements.prompt.disabled).toBe(false);
});

test("active projects omit archives, and the open archive stays pinned when the filter misses it", () => {
	const directory = {
		projects: [
			{ id: "p", name: "应用", cwd: "/work", createdAt: 1 },
			{ id: "gone", name: "旧项目", cwd: "/old", createdAt: 1, removed: true as const },
		],
		sessions: [
			{ sessionId: "live", createdAt: 4, cwd: "/work", projectId: "p", name: "进行中" },
			{ sessionId: "archived-session", createdAt: 1, cwd: "/old", projectId: "gone", name: "留下", archivedAt: 2 },
		],
	};
	const open = buildWebView({ ...input(true), directory, rosterFilter: "" });
	expect(open.roster.map(item => item.id)).toEqual(["live"]);
	expect(open.projects?.map(group => group.id)).toEqual(["p"]);
	expect(open.projects?.[0]?.items.map(item => item.id)).toEqual(["live"]);
	expect(open.archivedAttached?.id).toBe("archived-session");
	expect(open.empty).toBeUndefined();

	const filtered = buildWebView({ ...input(true), directory, rosterFilter: "does-not-match" });
	expect(filtered.roster).toEqual([]);
	expect(filtered.empty).toBe("没有匹配这个过滤条件的会话。");
	expect(filtered.archivedAttached?.id).toBe("archived-session");

	const onlyArchived = buildWebView({
		...input(true),
		directory: { ...directory, sessions: directory.sessions.filter(session => session.sessionId === "archived-session") },
		rosterFilter: "does-not-match",
	});
	expect(onlyArchived.roster).toEqual([]);
	expect(onlyArchived.empty).toBe("归档会话在设置 → 已归档。");
	expect(onlyArchived.archivedAttached?.label).toBe("留下");
});
