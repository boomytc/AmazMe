/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { CONVERSATION_ARCHIVE_ACTION, CONVERSATION_RENAME_ACTION, CONVERSATION_RESTORE_ACTION, CONVERSATION_SELECT_ACTION, CONVERSATIONS_REFRESH_ACTION, DOCK_TOGGLE_ACTION } from "../src/actions.ts";
import { conversationsPanel } from "../src/dock.ts";
import type { ConversationsStateLike } from "../src/dock.ts";
import { archiveForkModal } from "../src/fork-management.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { buildWebView } from "../src/view.ts";
import type { WebViewInput } from "../src/view.ts";

function conversations(archived = false): ConversationsStateLike {
	return { selected: "2", tasks: [], conversations: [
		{ id: "1", label: "main", root: true, role: "main", children: 1, hasEntries: true },
		{ id: "2", label: "方案 A", root: false, role: "fork", children: 1, hasEntries: true, parentConversationId: "1",
			run: archived ? "idle" : "working", queued: archived ? 0 : 2, ...(archived ? { archivedAt: 3, readOnly: true } : {}) },
		{ id: "3", label: "检查文件", root: false, role: "subagent", children: 0, hasEntries: true, ownerConversationId: "2", ownerTaskId: "9",
			...(archived ? { readOnly: true } : {}) },
	] };
}

function input(archived = false): WebViewInput {
	return { locale: "zh", submitMode: "followUp", attachments: [], rosterFilter: "", approvals: undefined,
		feedback: undefined, showWelcome: false, focus: "方案 A", history: [], historyMore: false,
		historyLoading: false, draft: "保留的草稿", commands: [], completions: [], paletteSelection: 0, platform: "",
		directory: { sessions: [{ sessionId: "s", createdAt: 1, cwd: "/work" }] }, attachedId: "s", transcript: undefined, now: 4,
		models: undefined, thinkingLevels: [], panel: { locale: "zh", current: "chat" },
		dock: { open: true, tab: "conversations", cwd: "/work", workspace: undefined, conversations: conversations(archived),
			terminal: { status: "idle", command: null, exitCode: null, output: "", truncated: false, error: null } },
	};
}

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});

function button(selector: string): HTMLButtonElement {
	const node = document.querySelector(selector);
	if (!(node instanceof HTMLButtonElement)) throw new Error(`Missing ${selector}`);
	return node;
}

test("only manual forks offer management, and list badges report running and queued work", () => {
	const rows = conversationsPanel("zh", conversations()).groups[0]?.rows ?? [];
	expect(rows[0]?.menu).toBeUndefined();
	expect(rows[2]?.menu).toBeUndefined();
	expect(rows[1]?.menu?.actions.map(action => action.id)).toEqual([CONVERSATION_RENAME_ACTION, CONVERSATION_ARCHIVE_ACTION]);
	expect(rows[1]?.badges).toContain("处理中");
	expect(rows[1]?.badges).toContain("排队 2 项");
	const archived = conversationsPanel("zh", conversations(true));
	expect(archived.groups[0]?.rows.map(row => row.id)).toEqual(["conversation:1"]);
	expect(archived.title).toBe("对话");
	expect(archived.groups[0]?.title).toBe("活动对话");
	expect(archived.groups[1]?.title).toBe("已归档分叉");
	expect(archived.groups[1]?.rows[0]?.actions?.map(action => action.id)).toEqual([CONVERSATION_SELECT_ACTION, CONVERSATION_RESTORE_ACTION]);
	expect(archived.groups[1]?.rows[1]?.actions?.map(action => action.id)).toEqual([CONVERSATION_SELECT_ACTION]);
	expect(archived.groups[1]?.rows.every(row => row.menu === undefined)).toBe(true);
	const parentArchived = conversationsPanel("zh", conversations(true), true);
	expect(parentArchived.groups[1]?.rows[0]?.actions?.find(action => action.id === CONVERSATION_RESTORE_ACTION)?.disabled).toBe(true);
});

test("a dock group that repeats the panel title folds into the panel head", () => {
	const renderer = createRenderer(collectPageElements());
	const view = buildWebView(input());
	renderer.render({
		...view,
		dock: {
			...view.dock,
			panel: {
				...view.dock.panel,
				groups: [...view.dock.panel.groups, { id: "conversations:return", title: "返回到", rows: [{ id: "return:7", title: "上文" }] }],
			},
		},
	});
	expect(document.querySelector("#dock-close")).toBeNull();
	expect(document.querySelector(`#run-actions [data-action="${DOCK_TOGGLE_ACTION}"]`)).toBeInstanceOf(HTMLButtonElement);
	expect([...document.querySelectorAll("#dock-body h1, #dock-body h2")].map(node => node.textContent)).toEqual(["对话", "返回到"]);
	expect(document.querySelector(`#dock-body .panel-head [data-action="${CONVERSATIONS_REFRESH_ACTION}"]`)).toBeInstanceOf(HTMLButtonElement);
	expect(document.querySelector("#dock-body [data-group-id='conversations:list'] .panel-group-head")).toBeNull();
	renderer.render(buildWebView(input(true)));
	expect(document.querySelector("#dock-body .panel-title")?.textContent).toBe("对话");
	expect(document.querySelector("[data-group-id='conversations:list'] .panel-group-title")?.textContent).toBe("活动对话");
	expect(document.querySelector(`#dock-body .panel-head [data-action="${CONVERSATIONS_REFRESH_ACTION}"]`)).toBeNull();
	expect(document.querySelector(`[data-group-id='conversations:list'] [data-action="${CONVERSATIONS_REFRESH_ACTION}"]`)).toBeInstanceOf(HTMLButtonElement);
});

test("archived fork execution is read-only without disabling the shared session terminal", () => {
	const archived = buildWebView(input(true));
	expect(archived.readOnly).toBe(true);
	expect(archived.lane).toContain("恢复分叉后可继续");
	expect(archived.run.fork.disabled).toBe(true);
	expect(archived.run.compact.disabled).toBe(true);
	const renderer = createRenderer(collectPageElements());
	renderer.render(archived);
	expect(collectPageElements().prompt.disabled).toBe(true);
	const sharedTerminal = buildWebView({ ...input(true), dock: { ...input(true).dock, tab: "terminal" } });
	expect(sharedTerminal.dock.panel.inputs?.[0]?.submit.disabled).toBe(false);
	const restored = buildWebView(input(false));
	renderer.render(restored);
	expect(restored.readOnly).toBeUndefined();
	expect(collectPageElements().prompt.disabled).toBe(false);
});

test("fork menus are keyboard-accessible, target the fork, and close when its state changes", () => {
	const renderer = createRenderer(collectPageElements());
	const report = vi.fn();
	renderer.onPanelAction = report;
	renderer.render(buildWebView(input()));
	const more = button('[data-row-id="conversation:2"] .panel-more');
	more.click();
	expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
	expect(document.activeElement).toBe(button(`[role="menuitem"][data-action="${CONVERSATION_RENAME_ACTION}"]`));
	document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	expect(document.querySelector('[role="menu"]')).toBeNull();
	expect(document.activeElement).toBe(more);
	more.click();
	button(`[role="menuitem"][data-action="${CONVERSATION_ARCHIVE_ACTION}"]`).click();
	expect(report).toHaveBeenLastCalledWith({ kind: "command", id: CONVERSATION_ARCHIVE_ACTION, data: "2" });
	more.click();
	renderer.render(buildWebView(input(true)));
	expect(document.querySelector('[role="menu"]')).toBeNull();
	expect(document.querySelector('[data-row-id="conversation:2"] .panel-more')).toBeNull();
	button(`[data-row-id="conversation:2"] [data-action="${CONVERSATION_RESTORE_ACTION}"]`).click();
	expect(report).toHaveBeenLastCalledWith({ kind: "command", id: CONVERSATION_RESTORE_ACTION, data: "2" });
});

test("archiving a fork confirms with cancel focused by default", () => {
	const renderer = createRenderer(collectPageElements());
	const view = buildWebView(input());
	renderer.render({ ...view, panel: { ...view.panel, modal: archiveForkModal("zh", "2") } });
	expect(document.activeElement?.textContent).toBe("取消");
	expect(document.querySelector("dialog#modal-root")?.textContent).toContain("不影响主线和其他分叉");
	expect(document.querySelector("dialog#modal-root")?.textContent).toContain("恢复不会重放");
});
