/** @vitest-environment happy-dom */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renameSessionModal } from "../src/panels.ts";
import { addProjectModal } from "../src/projects.ts";
import type { DirectoryListing } from "../src/directories.ts";
import type { PanelModal } from "../src/panels.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { failureView } from "../src/view.ts";
import { DEFAULT_TYPOGRAPHY } from "../src/typography.ts";

let cleanupListeners = (): void => {};
beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.className = "";
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
	const listeners = vi.spyOn(document, "addEventListener");
	const windowListeners = vi.spyOn(window, "addEventListener");
	cleanupListeners = () => {
		for (const [type, listener, options] of listeners.mock.calls) document.removeEventListener(type, listener, options);
		for (const [type, listener, options] of windowListeners.mock.calls) window.removeEventListener(type, listener, options);
	};
});
afterEach(() => { cleanupListeners(); vi.restoreAllMocks(); });

function setup() {
	const elements = collectPageElements();
	const renderer = createRenderer(elements);
	const view = { ...failureView("en", ""), newSession: { enabled: true }, projects: [] };
	const report = vi.fn();
	renderer.onPanelAction = report;
	renderer.render(view);
	const paint = (modal?: PanelModal) => renderer.render({ ...view, panel: { ...view.panel, modal } });
	const modal = renameSessionModal("en", "one", "Draft");
	return { elements, renderer, view, report, paint, modal };
}
function button(selector: string): HTMLButtonElement {
	const node = document.querySelector<HTMLButtonElement>(selector);
	if (!node) throw new Error(`Missing ${selector}`);
	return node;
}
function input(): HTMLInputElement {
	const node = document.querySelector<HTMLInputElement>(".modal-input");
	if (!node) throw new Error("Missing field");
	return node;
}
function escape(): void {
	document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}
function backdrop(root: HTMLElement): void {
	root.dispatchEvent(new Event("pointerdown", { bubbles: true }));
	root.click();
}

describe("native management modal", () => {
	test("applies role fonts without replacing the draft and leaves ordinary browser zoom untouched", () => {
		const { elements, renderer, view } = setup();
		const shortcut = vi.fn();
		renderer.onShortcut = shortcut;
		vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
		renderer.setDraft("unfinished draft", false);
		renderer.render({ ...view, typography: { ...DEFAULT_TYPOGRAPHY, textFont: "Arial", codeSize: 16, terminalSize: 18 } });
		expect(document.documentElement.style.getPropertyValue("--font-content")).toBe('"Arial", var(--font-sans)');
		expect(document.documentElement.style.getPropertyValue("--code-font-size")).toBe("16px");
		expect(document.documentElement.style.getPropertyValue("--terminal-font-size")).toBe("18px");
		expect(elements.prompt.value).toBe("unfinished draft");
		const key = () => new KeyboardEvent("keydown", { key: "=", code: "Equal", metaKey: true, bubbles: true, cancelable: true });
		const browser = key();
		elements.prompt.dispatchEvent(browser);
		expect(browser.defaultPrevented).toBe(false);
		expect(shortcut).not.toHaveBeenCalled();
		Object.defineProperty(window, "amazmeDesktop", { configurable: true, value: { pickDirectories: async () => [] } });
		try {
			const desktop = key();
			elements.prompt.dispatchEvent(desktop);
			expect(desktop.defaultPrevented).toBe(true);
			expect(shortcut).toHaveBeenCalledWith("font.increase");
		} finally {
			delete window.amazmeDesktop;
		}
	});

	test("opens with semantic labels and restores the trigger after closing and reopening", () => {
		const { elements, paint, modal } = setup();
		const trigger = button("#project-add");
		trigger.focus();
		paint(modal);
		expect(elements.modalRoot.open).toBe(true);
		expect(elements.modalRoot.getAttribute("aria-labelledby")).toBe("modal-title");
		expect(document.activeElement).toBe(input());
		paint();
		expect(elements.modalRoot.open).toBe(false);
		expect(elements.modalRoot.hidden).toBe(true);
		expect(document.activeElement).toBe(trigger);
		paint(modal);
		expect(elements.modalRoot.open).toBe(true);
	});

	test("resolves a replicated trigger rather than focusing a removed node", () => {
		const { renderer, view, paint, modal } = setup();
		const trigger = button("#project-add");
		trigger.focus();
		paint(modal);
		renderer.render({ ...view, newSession: { enabled: false }, panel: { ...view.panel, modal } });
		expect(button("#project-add")).not.toBe(trigger);
		paint();
		expect(document.activeElement).toBe(button("#project-add"));
	});

	test("locks every action and all dismissal paths while pending, then restores the draft", () => {
		const { elements, report, paint, modal } = setup();
		paint(modal);
		const field = input();
		field.value = "Unsubmitted";
		paint({ ...modal, pending: true });
		// happy-dom does not implement inherited :disabled; assert the native fieldset boundary here.
		expect(elements.modalRoot.querySelector<HTMLFieldSetElement>(".modal-body")?.disabled).toBe(true);
		for (const node of elements.modalRoot.querySelectorAll<HTMLButtonElement>(".modal-head button, .modal-foot button")) expect(node.disabled).toBe(true);
		escape();
		elements.modalRoot.dispatchEvent(new Event("cancel", { cancelable: true }));
		backdrop(elements.modalRoot);
		button(".modal-close").click();
		button(".modal-foot button:last-child").click();
		expect(report).not.toHaveBeenCalled();
		expect(elements.modalRoot.getAttribute("aria-busy")).toBe("true");
		paint({ ...modal, notice: { tone: "error", text: "Try again" } });
		expect(input()).toBe(field);
		expect(field.value).toBe("Unsubmitted");
		expect(field.disabled).toBe(false);
		expect(document.querySelector(".modal-notice")?.getAttribute("role")).toBe("alert");
		button(".modal-foot button:last-child").click();
		expect(report).toHaveBeenCalledWith({ kind: "modal-submit", id: modal.id, data: modal.data, fields: { name: "Unsubmitted" } });
		escape();
		expect(report).toHaveBeenLastCalledWith({ kind: "modal-close" });
	});

	test("does not dismiss dangerous actions by backdrop or a drag ending outside the card", () => {
		const { elements, report, paint, modal } = setup();
		paint({ ...modal, danger: true });
		expect(document.activeElement).toBe(button(".modal-foot button:first-child"));
		backdrop(elements.modalRoot);
		expect(report).not.toHaveBeenCalled();
		paint(modal);
		input().dispatchEvent(new Event("pointerdown", { bubbles: true }));
		elements.modalRoot.click();
		expect(report).not.toHaveBeenCalled();
		backdrop(elements.modalRoot);
		expect(report).toHaveBeenCalledOnce();
	});

	test("skips conditionally hidden fields and describes the visible field", () => {
		const { paint, modal } = setup();
		paint({ ...modal, fields: [
			{ id: "secret", label: "Hidden", kind: "text", value: "", visibleWhen: { field: "mode", values: ["other"] } },
			{ id: "mode", label: "Mode", kind: "select", value: "local", options: [{ value: "local", label: "Local" }, { value: "other", label: "Other" }], description: "Choose where to save" },
			{ id: "key", label: "Key", kind: "text", value: "", visibleWhen: [{ field: "mode", values: ["local"] }, { field: "gate", values: ["yes"] }] },
			{ id: "gate", label: "Gate", kind: "select", value: "no", options: [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }] },
		] });
		const field = document.querySelector<HTMLSelectElement>(".modal-input:not(:disabled)");
		expect(document.activeElement).toBe(field);
		expect(field?.getAttribute("aria-describedby")).toBe("modal-help-mode");
		expect(input().closest(".modal-field")?.hasAttribute("hidden")).toBe(true);
		const key = [...document.querySelectorAll(".modal-field")].find(node => node.textContent?.startsWith("Key"));
		expect(key?.hasAttribute("hidden")).toBe(true);
		const gate = [...document.querySelectorAll<HTMLSelectElement>("select.modal-input")].find(node => [...node.options].some(option => option.value === "yes"));
		if (!gate) throw new Error("Missing gate");
		gate.value = "yes";
		gate.dispatchEvent(new Event("change"));
		expect(key?.hasAttribute("hidden")).toBe(false);
	});

	test("late directory results cannot unlock a pending form or corrupt its settled control state", async () => {
		const { renderer, paint } = setup();
		const modal = addProjectModal("en");
		let finish: ((listing: DirectoryListing) => void) | undefined;
		const browse = vi.fn(() => new Promise<DirectoryListing>(resolve => { finish = resolve; }));
		renderer.onBrowseDirectories = browse;
		renderer.onPickDirectories = () => Promise.resolve(undefined);
		paint(modal);
		button(".directory-add").click();
		await vi.waitFor(() => expect(browse).toHaveBeenCalledOnce());
		paint({ ...modal, pending: true });
		finish!({ path: "/work", parent: null, entries: [{ name: "src", path: "/work/src" }] });
		await vi.waitFor(() => expect(document.querySelector(".directory-entry")).not.toBeNull());
		expect(button(".directory-entry").closest<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
		expect(button(".directory-choose").closest<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
		paint(modal);
		expect(button(".directory-entry").closest<HTMLFieldSetElement>("fieldset")?.disabled).toBe(false);
		expect(button(".directory-choose").disabled).toBe(false);
	});

	test("directory navigation waits for committed Enter rather than IME confirmation", async () => {
		const { renderer, paint } = setup();
		const browse = vi.fn(() => Promise.resolve({ path: "/work", parent: null, entries: [] }));
		renderer.onBrowseDirectories = browse;
		renderer.onPickDirectories = () => Promise.resolve(undefined);
		paint(addProjectModal("en"));
		button(".directory-add").click();
		await vi.waitFor(() => expect(browse).toHaveBeenCalledOnce());
		const path = document.querySelector<HTMLInputElement>(".directory-path")!;
		for (const composition of [{ isComposing: true }, { keyCode: 229 }]) path.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...composition }));
		expect(browse).toHaveBeenCalledOnce();
		path.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		expect(browse).toHaveBeenCalledTimes(2);
	});

	test("does not send IME Enter or global shortcuts through the modal", () => {
		const { renderer, report, paint, modal } = setup();
		const shortcut = vi.fn();
		renderer.onShortcut = shortcut;
		paint(modal);
		for (const composition of [{ isComposing: true }, { keyCode: 229 }]) input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...composition }));
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
		expect(report).not.toHaveBeenCalled();
		expect(shortcut).not.toHaveBeenCalled();
	});
});
