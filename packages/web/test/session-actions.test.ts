/** @vitest-environment happy-dom */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SESSION_RENAME_ACTION } from "../src/actions.ts";
import { removeSessionModal, renameSessionModal } from "../src/panels.ts";
import { archiveSessionModal, projectGroups, COMPOSER_PROJECT_ACTION, PROJECT_ADD_ACTION, SESSION_ARCHIVE_ACTION, SESSION_ARCHIVE_MODAL, SESSION_RESTORE_ACTION } from "../src/projects.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { failureView, rosterItems } from "../src/view.ts";
import { MODEL_CONNECTIONS_ACTION, providerConfigurationModal } from "../src/model-connections.ts";

const directory = { sessions: [{ sessionId: "stable-session-id", createdAt: 1, name: "Weekly report", cwd: "/work" }] };

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.innerHTML = html
		.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});

function paint() {
	const renderer = createRenderer(collectPageElements());
	const view = {
		...failureView("en", ""),
		attachedId: "stable-session-id",
		roster: rosterItems("en", directory, "stable-session-id", 1),
		newSession: { enabled: true },
	};
	renderer.render(view);
	return { renderer, view };
}

function control(selector: string): HTMLButtonElement {
	const node = document.querySelector(selector);
	if (!(node instanceof HTMLButtonElement)) throw new Error(`Missing button ${selector}`);
	return node;
}

describe("session actions", () => {
	test("editing a connection preserves custom model definitions without copying the built-in catalog", () => {
		const modal = providerConfigurationModal("en", { id: "openai", name: "OpenAI", baseUrl: "https://example.test/v1", api: "openai-completions", modelCount: 2, custom: true, modelIds: ["custom-model"], configured: true, verification: { status: "idle" } }, [
			{ provider: "openai", modelId: "builtin-model", name: "Built-in", available: true },
			{ provider: "openai", modelId: "custom-model", name: "Custom", available: true },
		]);
		expect(modal.fields.find(field => field.id === "models")?.value).toBe("custom-model");
	});

	test("the new chat model menu searches models, selects reasoning, and opens connection management without clearing input", () => {
		const { renderer, view } = paint();
		const select = vi.fn(), think = vi.fn(), action = vi.fn();
		renderer.onSelectModel = select; renderer.onSelectThinking = think; renderer.onPanelAction = action;
		renderer.render({ ...view, attachedId: undefined, sessionDraft: { projectId: null, label: "Work outside a project", projects: [], disabled: false }, model: {
			...view.model, disabled: false, label: "First", effort: "Low",
			groups: [{ provider: "one", options: [{ provider: "one", modelId: "first", label: "First", selected: true }] }, { provider: "two", options: [{ provider: "two", modelId: "second", label: "Second", selected: false }] }],
			levels: [{ level: "low", label: "Low", selected: true }, { level: "high", label: "High", selected: false }],
		} });
		renderer.setDraft("keep my draft", false);
		control(".composer-model-picker").click();
		const dialog = document.querySelector<HTMLDialogElement>(".model-picker-menu")!;
		expect(dialog.open).toBe(true);
		const search = dialog.querySelector<HTMLInputElement>("input")!;
		search.value = "second"; search.dispatchEvent(new Event("input"));
		expect(dialog.querySelectorAll(".model-picker-option")).toHaveLength(1);
		control(".model-picker-option").click(); expect(select).toHaveBeenLastCalledWith("two", "second");
		control(".composer-model-picker").click(); control(".model-picker-reasoning button:last-child").click();
		expect(think).toHaveBeenLastCalledWith("high");
		control(".composer-model-picker").click(); control(".model-picker-manage").click();
		expect(action).toHaveBeenLastCalledWith({ kind: "command", id: MODEL_CONNECTIONS_ACTION, data: undefined });
		expect(document.querySelector<HTMLTextAreaElement>("#prompt")?.value).toBe("keep my draft");
	});

	test("a new chat chooses its project above the editable composer without a synthetic project group", () => {
		const { renderer, view } = paint();
		const report = vi.fn();
		const create = vi.fn();
		renderer.onPanelAction = report; renderer.onCreateSession = create;
		const standalone = { projects: [], sessions: [{ ...directory.sessions[0]!, projectId: null }] };
		const roster = rosterItems("zh", standalone, "stable-session-id", 1);
		const context = { projectId: null, label: "不在项目中工作", projects: [{ id: "p", name: "AmazMe" }, { id: "q", name: "LightUI" }], disabled: false };
		renderer.render({ ...view, locale: "zh", attachedId: undefined, roster, projects: projectGroups(standalone, roster, null, ""), sessionDraft: context });
		expect(document.querySelector(".project-group")).toBeNull();
		expect(document.querySelector(".session-group-label")?.textContent).toBe("聊天");
		expect(control("#primary").disabled).toBe(true);
		expect(document.querySelector<HTMLTextAreaElement>("#prompt")?.disabled).toBe(false);
		control("#new-chat").click(); expect(create).toHaveBeenCalledOnce();
		control(".composer-project").click();
		const menu = document.querySelector<HTMLDialogElement>(".project-picker")!;
		expect(menu.open).toBe(true);
		const search = menu.querySelector<HTMLInputElement>("input")!;
		search.value = "amaz"; search.dispatchEvent(new Event("input"));
		expect(menu.querySelectorAll(".project-picker-list button")).toHaveLength(1);
		menu.querySelector<HTMLButtonElement>(".project-picker-list button")!.click();
		expect(report).toHaveBeenLastCalledWith({ kind: "command", id: COMPOSER_PROJECT_ACTION, data: "p" });
		control(".composer-project").click();
		const actions = menu.querySelectorAll<HTMLButtonElement>(":scope > .project-picker-option");
		actions[0]!.click();
		expect(report).toHaveBeenLastCalledWith({ kind: "command", id: PROJECT_ADD_ACTION, data: undefined });
		control(".composer-project").click(); actions[1]!.click();
		expect(report).toHaveBeenLastCalledWith({ kind: "command", id: COMPOSER_PROJECT_ACTION, data: undefined });
	});

	test("menu and selection are sibling buttons and menu actions do not select a session", () => {
		const { renderer } = paint();
		const select = vi.fn();
		const report = vi.fn();
		renderer.onSelect = select;
		renderer.onPanelAction = report;
		const trigger = control(".session-more");
		expect(trigger.closest(".session-row")?.querySelector("button button")).toBeNull();
		trigger.click();
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
		control(`[data-action="${SESSION_RENAME_ACTION}"]`).click();
		expect(report).toHaveBeenCalledWith({ kind: "command", id: SESSION_RENAME_ACTION, data: "stable-session-id" });
		expect(select).not.toHaveBeenCalled();
		expect(document.querySelector(".session-menu")).toBeNull();
	});

	test("project sessions expose one archive action, replaced by restore when archived", () => {
		const { renderer, view } = paint();
		const report = vi.fn();
		renderer.onPanelAction = report;
		renderer.render({ ...view, locale: "zh", projects: [] });
		expect(document.querySelector(".project-archive-toggle")).toBeNull();
		expect(document.querySelector(".sidebar-label")?.textContent).toContain("项目");
		expect(document.querySelector(".project-group.archived")).toBeNull();
		control(".session-more").click();
		expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(4);
		expect(control(`[data-action="${SESSION_ARCHIVE_ACTION}"]`).textContent).toBe("归档");
		expect(document.querySelector('[data-action="session:end-work"]')).toBeNull();
		control(`[data-action="${SESSION_ARCHIVE_ACTION}"]`).click();
		expect(report).toHaveBeenCalledWith({ kind: "command", id: SESSION_ARCHIVE_ACTION, data: "stable-session-id" });

		const pinned = view.roster[0];
		if (pinned === undefined) throw new Error("Missing roster row");
		renderer.render({
			...view,
			locale: "zh",
			projects: [{ id: "p", name: "App", cwd: "/work", selected: true, items: [] }],
			roster: [],
			archivedAttached: { ...pinned, archived: true, attached: true },
		});
		expect(document.querySelector(".project-archive-toggle")).toBeNull();
		expect(document.querySelector(".sidebar-label")?.textContent).toContain("项目");
		const archived = document.querySelector(".project-group.archived");
		expect(archived?.querySelector(".project-select")).toBeNull();
		expect(archived?.querySelectorAll("[data-session-id]")).toHaveLength(1);
		expect(archived?.querySelector("[data-session-id]")?.getAttribute("data-session-id")).toBe("stable-session-id");
		archived?.querySelector<HTMLButtonElement>(".session-more")?.click();
		expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(4);
		expect(document.querySelector(`[data-action="${SESSION_ARCHIVE_ACTION}"]`)).toBeNull();
		expect(document.querySelector('[data-action="session:end-work"]')).toBeNull();
		control(`[data-action="${SESSION_RESTORE_ACTION}"]`).click();
		expect(report).toHaveBeenCalledWith({ kind: "command", id: SESSION_RESTORE_ACTION, data: "stable-session-id" });
	});

	test("archive confirmation explains cancellation, keeps a safe focus, and submits the unified action", () => {
		const { renderer, view } = paint();
		const report = vi.fn();
		renderer.onPanelAction = report;
		const modal = archiveSessionModal("zh", "stable-session-id");
		expect(modal.title).toBe("归档");
		expect(modal.submit).toBe("归档");
		expect(modal.description).toContain("停止运行中的任务、排队输入和终端命令");
		expect(modal.description).toContain("文件修改不会回滚");
		expect(modal.description).toContain("已取消的任务不会自动重放");
		renderer.render({ ...view, locale: "zh", panel: { ...view.panel, modal } });
		expect(document.activeElement).toBe(control(".modal-foot button:first-child"));
		control(".modal-foot button:first-child").click();
		expect(report).toHaveBeenLastCalledWith({ kind: "modal-close" });
		control(".modal-foot button:last-child").click();
		expect(report).toHaveBeenLastCalledWith({ kind: "modal-submit", id: SESSION_ARCHIVE_MODAL, data: "stable-session-id", fields: {} });
	});

	test("copies the full immutable ID and reports failure or success in place", async () => {
		const { renderer } = paint();
		const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
		control(".session-more").click();
		control('[data-action="session:copy-id"]').click();
		await vi.waitFor(() => expect(control('[data-action="session:copy-id"]').textContent).toBe("Copied"));
		expect(write).toHaveBeenCalledWith("stable-session-id");
		write.mockRejectedValue(new Error("denied"));
		control('[data-action="session:copy-id"]').click();
		await vi.waitFor(() => expect(control('[data-action="session:copy-id"]').textContent).toBe("Copy failed"));
		expect(renderer.view?.attachedId).toBe("stable-session-id");
		write.mockRestore();
	});

	test("keyboard menu navigation, Escape and outside clicks preserve predictable focus", () => {
		paint();
		const trigger = control(".session-more");
		trigger.click();
		const first = control('[data-action="session:rename"]');
		expect(document.activeElement).toBe(first);
		first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(document.activeElement).toBe(control('[data-action="session:copy-id"]'));
		document.activeElement?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
		);
		expect(document.querySelector(".session-menu")).toBeNull();
		expect(document.activeElement).toBe(trigger);
		trigger.click();
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(document.querySelector(".session-menu")).toBeNull();
	});

	test("streaming repaints preserve the open menu, and pending creation disables the button", () => {
		const { renderer, view } = paint();
		control(".session-more").click();
		const menu = document.querySelector(".session-menu");
		renderer.render({ ...view, status: "Working" });
		expect(document.querySelector(".session-menu")).toBe(menu);
		renderer.render({
			...view,
			projects: [{ id: "p", name: "App", cwd: "/work", selected: true, items: view.roster }],
			newSession: { enabled: false, pending: true },
		});
		const create = control(".project-new-session");
		expect(create.disabled).toBe(true);
		expect(create.getAttribute("aria-busy")).toBe("true");
		expect(create.getAttribute("aria-label")).toContain("Opening session");
	});

	test("rename submits with Enter in a native modal dialog", () => {
		const { renderer, view } = paint();
		const report = vi.fn();
		renderer.onPanelAction = report;
		const modal = renameSessionModal("en", "stable-session-id", "Weekly report");
		renderer.render({ ...view, panel: { ...view.panel, modal } });
		const input = document.querySelector<HTMLInputElement>(".modal-input");
		if (input === null) throw new Error("Missing rename field");
		expect(document.activeElement).toBe(input);
		input.value = "New title";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		expect(report).toHaveBeenCalledWith({
			kind: "modal-submit",
			id: modal.id,
			data: modal.data,
			fields: { name: "New title" },
		});
		const dialog = document.querySelector("dialog#modal-root");
		expect(dialog).toBeInstanceOf(HTMLDialogElement);
		expect(dialog?.hasAttribute("open")).toBe(true);
		expect(dialog?.getAttribute("aria-labelledby")).toBe("modal-title");
	});

	test("a removal confirmation initially focuses its safe cancel action", () => {
		const { renderer, view } = paint();
		renderer.render({ ...view, panel: { ...view.panel, modal: removeSessionModal("en", "stable-session-id") } });
		expect(document.activeElement).toBe(control(".modal-foot button:first-child"));
	});

	test("rename modal preserves typed text while pending or failed", () => {
		const { renderer, view } = paint();
		const modal = renameSessionModal("en", "stable-session-id", "Weekly report");
		renderer.render({ ...view, panel: { ...view.panel, modal } });
		const input = document.querySelector<HTMLInputElement>(".modal-input");
		if (input === null) throw new Error("Missing rename field");
		input.value = "New title";
		renderer.render({ ...view, panel: { ...view.panel, modal: { ...modal, pending: true } } });
		expect(document.querySelector(".modal-input")).toBe(input);
		expect(input.value).toBe("New title");
		renderer.render({
			...view,
			panel: { ...view.panel, modal: { ...modal, notice: { tone: "error", text: "host unavailable" } } },
		});
		expect(input.value).toBe("New title");
		expect(document.querySelector(".modal-notice")?.textContent).toBe("host unavailable");
	});
});
