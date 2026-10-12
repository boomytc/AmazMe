/** @vitest-environment happy-dom */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SESSION_RENAME_ACTION } from "../src/actions.ts";
import { removeSessionModal, renameSessionModal } from "../src/panels.ts";
import { archiveSessionModal, SESSION_ARCHIVE_ACTION, SESSION_ARCHIVE_MODAL, SESSION_RESTORE_ACTION } from "../src/projects.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { failureView, rosterItems } from "../src/view.ts";

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
