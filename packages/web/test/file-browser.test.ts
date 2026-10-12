/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { WORKSPACE_OPEN_ACTION, WORKSPACE_READ_ACTION, WORKSPACE_RELOAD_ACTION } from "../src/actions.ts";
import { filesPanel, workspacePath, parseWorkspaceAction } from "../src/dock.ts";
import type { WorkspaceStateLike } from "../src/dock.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { buildWebView } from "../src/view.ts";
import type { WebViewInput } from "../src/view.ts";

const listing: WorkspaceStateLike = { cwd: "/workspace/project", view: { kind: "listing", path: "src", parent: ".", entries: [
	{ name: "components", kind: "dir", size: 0 },
	{ name: "index.ts", kind: "file", size: 2048 },
	{ name: ".env", kind: "file", size: 31 },
], page: { offset: 0, limit: 100, total: 3 } } };

function view(workspace = listing, sessionId = "s") {
	const input: WebViewInput = { locale: "zh", submitMode: "prompt", attachments: [], rosterFilter: "", approvals: undefined,
		feedback: undefined, showWelcome: false, focus: "main", history: [], historyMore: false, historyLoading: false,
		draft: "", commands: [], completions: [], paletteSelection: 0, platform: "", models: undefined, thinkingLevels: [],
		directory: { sessions: [{ sessionId, cwd: workspace.cwd, createdAt: 1 }] }, attachedId: sessionId, transcript: undefined, now: 2,
		panel: { locale: "zh", current: "chat" }, dock: { open: true, tab: "files", cwd: workspace.cwd, workspace, terminal: undefined, conversations: undefined } };
	return buildWebView(input);
}
function field(): HTMLInputElement {
	const node = document.querySelector(".file-filter-input");
	if (!(node instanceof HTMLInputElement)) throw new Error("Missing file filter");
	return node;
}
function visible(): string[] {
	return [...document.querySelectorAll<HTMLButtonElement>(".file-entry:not([hidden])")].map(node => node.dataset.fileName ?? "");
}
function command(selector: string): HTMLButtonElement {
	const node = document.querySelector(selector);
	if (!(node instanceof HTMLButtonElement)) throw new Error(`Missing ${selector}`);
	return node;
}
function filter(value: string): void { field().value = value; field().dispatchEvent(new Event("input", { bubbles: true })); }
const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>")).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
	writeText.mockClear();
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

test("shows the current breadcrumb as text, binds ancestor and row actions to the displayed workspace", () => {
	const renderer = createRenderer(collectPageElements());
	const report = vi.fn(); renderer.onPanelAction = report; renderer.render(view());
	expect(document.querySelector('.file-breadcrumbs [aria-current="page"]')?.textContent).toBe("src");
	expect(document.querySelector(".file-crumb.current")?.tagName).toBe("SPAN");
	command(".file-breadcrumbs button").click();
	expect(report).toHaveBeenLastCalledWith({ kind: "command", id: WORKSPACE_OPEN_ACTION, data: listing.cwd });
	command('.file-entry[data-file-name="index.ts"]').click();
	expect(report).toHaveBeenLastCalledWith({ kind: "command", id: WORKSPACE_READ_ACTION, data: "/workspace/project/src/index.ts" });
	expect(document.querySelector('.file-entry[data-file-name="index.ts"] use')?.getAttribute("href")).toBe("#i-file");
	expect(document.querySelector(".file-entry-dir use")?.getAttribute("href")).toBe("#i-folder");
	expect(document.querySelectorAll(".file-entry button")).toHaveLength(0);
	expect(workspacePath("/", "src")).toBe("/src");
	expect(workspacePath("C:\\project\\", "src\\index.ts")).toBe("C:\\project/src\\index.ts");
});

test("filters only current-page names without hiding the parent, and clear restores the listing", () => {
	const renderer = createRenderer(collectPageElements()); renderer.render(view());
	filter("INDEX"); expect(visible()).toEqual(["上一层", "index.ts"]);
	expect(document.querySelector(".file-filter-status")?.textContent).toContain("匹配 1 项");
	filter("unknown"); expect(visible()).toEqual(["上一层"]);
	expect(document.querySelector<HTMLElement>(".file-filter-empty")?.hidden).toBe(false);
	command('[aria-label="清除文件名过滤"]').click();
	expect(visible()).toEqual(["上一层", "components", "index.ts", ".env"]);
	expect(document.activeElement).toBe(field());
});

test("keeps filter and selection through refresh, but resets on page, workspace or session changes", () => {
	const renderer = createRenderer(collectPageElements()); renderer.render(view());
	field().focus(); filter("index"); field().setSelectionRange(1, 3);
	if (listing.view.kind !== "listing") throw new Error("Missing listing");
	renderer.render(view({ ...listing, view: { ...listing.view, entries: [...listing.view.entries, { name: "index.test.ts", kind: "file", size: 1 }] } }));
	expect(field().value).toBe("index"); expect(document.activeElement).toBe(field()); expect(field().selectionStart).toBe(1);
	expect(visible()).toEqual(["上一层", "index.ts", "index.test.ts"]);
	renderer.render(view({ ...listing, view: { ...listing.view, page: { offset: 100, limit: 100, total: 203 } } }));
	expect(field().value).toBe("");
	filter("index"); renderer.render(view({ ...listing, cwd: "/another/project" })); expect(field().value).toBe("");
	filter("index"); renderer.render(view(listing, "second")); expect(field().value).toBe("");
});

test("keyboard navigation skips filtered rows and Escape clears only the filter", () => {
	const renderer = createRenderer(collectPageElements()); renderer.render(view());
	filter(".ts"); field().focus(); field().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
	expect(document.activeElement).toBe(command('.file-entry[data-file-name="index.ts"]'));
	document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
	expect(document.activeElement).toBe(command(".file-entry-up"));
	document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
	expect(document.activeElement).toBe(command('.file-entry[data-file-name="index.ts"]'));
	field().focus(); const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); field().dispatchEvent(escape);
	expect(escape.defaultPrevented).toBe(true); expect(field().value).toBe(""); expect(collectPageElements().dock.hidden).toBe(false);
});

test("pending navigation keeps contents visible, disables competing navigation, then restores focus", () => {
	const renderer = createRenderer(collectPageElements()); const report = vi.fn(); renderer.onPanelAction = report;
	const initial = view(); renderer.render(initial); const opener = command('.file-entry[data-file-name="index.ts"]'); opener.focus();
	renderer.render({ ...initial, dock: { ...initial.dock, panel: { ...initial.dock.panel, pending: { id: WORKSPACE_READ_ACTION, data: opener.dataset.actionData } } } });
	expect(visible()).toContain("index.ts"); expect(document.querySelector('[data-panel-id="files"]')?.getAttribute("aria-busy")).toBe("true");
	for (const control of document.querySelectorAll<HTMLButtonElement>(".file-entry, .file-breadcrumbs button")) expect(control.disabled).toBe(true);
	expect(document.querySelector(".file-operation-status")?.textContent).toBe("正在读取文件…");
	renderer.render(initial); expect(document.activeElement).toBe(command('.file-entry[data-file-name="index.ts"]'));
	expect(command('.file-entry[data-file-name="index.ts"]').disabled).toBe(false);
});

test("source preview is literal, line-numbered, copyable without gutters, and wrap state survives repaint", async () => {
	const renderer = createRenderer(collectPageElements());
	const text = "<img src=x onerror=alert(1)>\r\n\r\nexport const value = 1;\r\n";
	const workspace: WorkspaceStateLike = { ...listing, view: { kind: "text", path: "src/index.ts", text, truncated: false } };
	renderer.render(view(workspace));
	expect([...document.querySelectorAll(".file-line-number")].map(node => node.textContent)).toEqual(["1", "2", "3"]);
	expect(document.querySelector(".file-source-code img")).toBeNull(); expect(document.querySelector(".file-line-code")?.textContent).not.toContain("\r");
	command('[aria-label="复制已显示的内容"]').click(); await Promise.resolve(); expect(writeText).toHaveBeenLastCalledWith(text);
	command('[aria-label="复制完整路径"]').click(); await Promise.resolve(); expect(writeText).toHaveBeenLastCalledWith("/workspace/project/src/index.ts");
	command('[aria-label="长行自动换行"]').click(); expect(document.querySelector(".file-source-code")?.classList.contains("wrap")).toBe(true);
	renderer.render({ ...view(workspace), locale: "en" }); expect(command('[aria-label="Wrap long lines"]').getAttribute("aria-pressed")).toBe("true");
});

test("bounds newline-heavy source DOM and copies only the explicitly limited preview", async () => {
	const renderer = createRenderer(collectPageElements());
	renderer.render(view({ ...listing, view: { kind: "text", path: "huge.txt", text: "line\n".repeat(2500), truncated: false } }));
	expect(document.querySelectorAll(".file-source-line")).toHaveLength(2000);
	expect(document.querySelector(".file-source .panel-notice")?.textContent).toContain("仅预览前 2000 行");
	command('[aria-label="复制已显示的内容"]').click(); await Promise.resolve(); expect(writeText).toHaveBeenLastCalledWith(Array(2000).fill("line").join("\n"));
});

test("distinguishes empty source, empty directory and an empty filtered result", () => {
	const renderer = createRenderer(collectPageElements());
	renderer.render(view({ ...listing, view: { kind: "text", path: "empty.txt", text: "", truncated: false } }));
	expect(document.querySelector(".file-source-code")?.textContent).toBe("这是一个空文件。");
	renderer.render(view({ ...listing, view: { kind: "listing", path: ".", parent: null, entries: [], page: { offset: 0, limit: 100, total: 0 } } }));
	filter("missing"); expect(document.querySelector<HTMLElement>(".file-entries > .panel-empty:not(.file-filter-empty)")?.hidden).toBe(true);
	expect(document.querySelector<HTMLElement>(".file-filter-empty")?.hidden).toBe(false);
});

test("page and refresh targets bind absolute displayed paths, and invalid targets are rejected", () => {
	if (listing.view.kind !== "listing") throw new Error("Missing listing");
	const panel = filesPanel("en", { ...listing, view: { ...listing.view, page: { offset: 0, limit: 100, total: 203 } } });
	const actions = panel.groups[0]?.actions ?? [];
	expect(actions.map(action => parseWorkspaceAction(action.data))).toEqual([
		{ kind: "open", path: "/workspace/project/src" }, { kind: "open", path: "/workspace/project/src", offset: 100 },
	]);
	const preview = filesPanel("en", { ...listing, view: { kind: "text", path: "src/index.ts", text: "first", truncated: false } });
	expect(parseWorkspaceAction(preview.groups[0]?.actions?.[0]?.data)).toEqual({ kind: "read", path: "/workspace/project/src/index.ts" });
	for (const data of [undefined, "null", "{}", JSON.stringify({ kind: "read", path: "/a", offset: 1 }), JSON.stringify({ kind: "open", path: "/a", offset: -1 })]) expect(() => parseWorkspaceAction(data)).toThrow();
});

test("denied paths retain only the safe workspace breadcrumb and return action", () => {
	const panel = filesPanel("zh", { ...listing, view: { kind: "denied", path: "../private", reason: "Folder is outside project workspaces." } });
	expect(panel.files?.breadcrumbs.map(crumb => crumb.path)).toEqual([listing.cwd]);
	expect(panel.groups[0]?.rows[0]?.file?.action.data).toBe(listing.cwd);
	expect(panel.notices[0]?.tone).toBe("error"); expect(panel.groups[0]?.actions?.[0]?.id).toBe(WORKSPACE_RELOAD_ACTION);
});
