/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { DOCK_TAB_ACTION, WELCOME_SESSION_ACTION } from "../src/actions.ts";
import { SESSION_RESTORE_ACTION } from "../src/projects.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { buildWebView, type WebViewInput } from "../src/view.ts";

function input(rosterFilter: string): WebViewInput {
	return {
		locale: "zh",
		submitMode: "followUp",
		attachments: [],
		rosterFilter,
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
		panel: { locale: "zh", current: "chat" },
		directory: undefined,
		transcript: undefined,
		attachedId: undefined,
		now: 0,
		models: undefined,
		thinkingLevels: [],
		dock: {
			open: false,
			tab: "files",
			cwd: "",
			workspace: undefined,
			terminal: undefined,
			conversations: undefined,
		},
	};
}

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});

test("the session filter stays an icon in the brand row until it is opened", () => {
	const elements = collectPageElements();
	const renderer = createRenderer(elements);
	const queries: string[] = [];
	renderer.onFilterRoster = (text) => {
		queries.push(text);
	};
	renderer.render(buildWebView(input("")));
	expect(elements.rosterFilterField.closest(".brand")).toBe(elements.sessionSidebar.querySelector(".brand"));
	expect(elements.rosterFilter.hidden).toBe(true);
	expect(elements.rosterFilterToggle.getAttribute("aria-expanded")).toBe("false");

	elements.rosterFilterToggle.click();
	expect(elements.rosterFilter.hidden).toBe(false);
	expect(elements.rosterFilterToggle.getAttribute("aria-expanded")).toBe("true");
	expect(document.activeElement).toBe(elements.rosterFilter);

	elements.rosterFilter.value = "周";
	elements.rosterFilter.dispatchEvent(new Event("input"));
	expect(queries).toEqual(["周"]);

	elements.rosterFilter.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	expect(queries).toEqual(["周", ""]);
	expect(elements.rosterFilter.hidden).toBe(true);
	expect(document.activeElement).toBe(elements.rosterFilterToggle);

	renderer.render(buildWebView(input("周报")));
	expect(elements.rosterFilter.hidden).toBe(false);
	expect(elements.rosterFilter.value).toBe("周报");
});

test("first use offers a working create action and refreshes it through pending and failure", () => {
	const renderer = createRenderer(collectPageElements());
	const report = vi.fn();
	renderer.onPanelAction = report;
	const state = { ...input(""), directory: { sessions: [] } };
	renderer.render(buildWebView(state));
	const create = () => document.querySelector<HTMLButtonElement>(`#transcript-empty [data-action="${WELCOME_SESSION_ACTION}"]`)!;
	create().click();
	expect(report).toHaveBeenCalledWith({ kind: "command", id: WELCOME_SESSION_ACTION, data: undefined });
	renderer.render(buildWebView({ ...state, creatingSession: true }));
	expect(create().disabled).toBe(true);
	expect(create().getAttribute("aria-busy")).toBe("true");
	expect(create().textContent).toContain("正在打开");
	renderer.render(buildWebView(state));
	expect(create().disabled).toBe(false);
	expect(create().getAttribute("aria-busy")).toBe("false");
});

test("welcome offers no unattached file tools and follows host availability", () => {
	const renderer = createRenderer(collectPageElements());
	const view = buildWebView({ ...input(""), showWelcome: true, directory: { sessions: [] } });
	renderer.render(view);
	expect(document.querySelectorAll(".welcome-steps button")).toHaveLength(2);
	expect(document.querySelector('.welcome-steps [data-action="welcome:files"]')).toBeNull();
	renderer.render({ ...view, newSession: { enabled: false } });
	expect(document.querySelector<HTMLButtonElement>(`.welcome-steps [data-action="${WELCOME_SESSION_ACTION}"]`)?.disabled).toBe(true);
});

test("a filtered zero offers clearing instead of creation and returns to existing sessions", () => {
	const renderer = createRenderer(collectPageElements());
	const state = { ...input("missing"), directory: { sessions: [{ sessionId: "one", name: "周报", cwd: "/work", createdAt: 1 }] } };
	renderer.onFilterRoster = query => renderer.render(buildWebView({ ...state, rosterFilter: query }));
	renderer.render(buildWebView(state));
	expect(document.querySelector("#transcript-empty")?.textContent).toContain("没有匹配的会话");
	expect(document.querySelector(`#transcript-empty [data-action="${WELCOME_SESSION_ACTION}"]`)).toBeNull();
	document.querySelector<HTMLButtonElement>("#transcript-empty button")?.click();
	expect(document.querySelector(".session-select")?.textContent).toContain("周报");
	expect(document.querySelector("#transcript-empty")?.textContent).toContain("选一个会话继续");
	document.body.classList.add("sidebar-collapsed");
	document.querySelector<HTMLButtonElement>("#transcript-empty button")?.click();
	expect(document.body.classList.contains("sidebar-collapsed")).toBe(false);
	expect(document.activeElement?.classList.contains("session-select")).toBe(true);
});

test("waiting for a host is not presented as an empty library or enabled creation", () => {
	const renderer = createRenderer(collectPageElements());
	renderer.render(buildWebView(input("")));
	expect(document.querySelector("#transcript-empty")?.textContent).toContain("等待宿主连接");
	expect(document.querySelector("#transcript-empty button")).toBeNull();
});

test("an expanded empty project supplies one empty explanation, not a second host footer", () => {
	const renderer = createRenderer(collectPageElements());
	renderer.render(buildWebView({ ...input(""), selectedProjectId: "p", directory: { sessions: [], projects: [{ id: "p", name: "App", cwd: "/work", createdAt: 1 }] } }));
	expect(document.querySelectorAll("#roster .empty-state")).toHaveLength(1);
	expect(document.querySelector("#roster-empty")).toBeNull();
});

test("an empty read-only session offers recovery rather than asking for an unsendable task", () => {
	const renderer = createRenderer(collectPageElements());
	const report = vi.fn();
	renderer.onPanelAction = report;
	const view = buildWebView({ ...input(""), attachedId: "one", directory: { sessions: [{ sessionId: "one", name: "周报", cwd: "/work", createdAt: 1, archivedAt: 2 }] } });
	renderer.render(view);
	expect(document.querySelector("#transcript-empty")?.textContent).toContain("当前对话为只读");
	document.querySelector<HTMLButtonElement>("#transcript-empty button")?.click();
	expect(report).toHaveBeenLastCalledWith({ kind: "command", id: SESSION_RESTORE_ACTION, data: "one" });
	renderer.render({ ...view, archivedAttached: undefined });
	document.querySelector<HTMLButtonElement>("#transcript-empty button")?.click();
	expect(report).toHaveBeenLastCalledWith({ kind: "command", id: DOCK_TAB_ACTION, data: "conversations" });
});
