/** @vitest-environment happy-dom */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DOCK_TOGGLE_ACTION } from "../src/actions.ts";
import { dockView } from "../src/dock.ts";
import type { PanelAction } from "../src/panels.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { failureView } from "../src/view.ts";

let narrow = true;
let cleanupListeners = (): void => {};
beforeEach(() => {
	narrow = true;
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.className = "";
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
	vi.spyOn(window, "matchMedia").mockImplementation(media => ({ matches: narrow, media, onchange: null,
		addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true }));
	const documentListeners = vi.spyOn(document, "addEventListener");
	const windowListeners = vi.spyOn(window, "addEventListener");
	cleanupListeners = () => {
		for (const [type, listener, options] of documentListeners.mock.calls) document.removeEventListener(type, listener, options);
		for (const [type, listener, options] of windowListeners.mock.calls) window.removeEventListener(type, listener, options);
	};
});
afterEach(() => { cleanupListeners(); vi.restoreAllMocks(); });

function setup() {
	const elements = collectPageElements();
	const renderer = createRenderer(elements);
	let open = false;
	const paint = (next: boolean) => {
		open = next;
		renderer.render({ ...failureView("en", ""), attachedId: "one", newSession: { enabled: true },
			dock: dockView("en", { open, tab: "files", cwd: "/work", workspace: undefined, terminal: undefined, conversations: undefined }) });
	};
	const report = vi.fn((action: PanelAction) => { if (action.kind === "command" && action.id === DOCK_TOGGLE_ACTION) paint(!open); });
	renderer.onPanelAction = report;
	paint(false);
	return { elements, renderer, paint, report };
}
function escape(): void {
	document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

test("a narrow dock owns focus and has a reachable close button outside its tab group", () => {
	const { elements, paint } = setup();
	paint(true);
	expect(elements.center.inert).toBe(true);
	expect(elements.sidebar.inert).toBe(true);
	expect(document.activeElement?.getAttribute("role")).toBe("tab");
	const close = document.querySelector<HTMLButtonElement>("#dock-close")!;
	expect(close.tabIndex).toBe(0);
	expect(close.hasAttribute("aria-selected")).toBe(false);
	expect(close.closest('[role="tablist"]')).toBeNull();
	close.focus(); close.click();
	expect(elements.dock.hidden).toBe(true);
	expect(elements.center.inert).toBe(false);
	expect((document.activeElement as HTMLElement).dataset.action).toBe(DOCK_TOGGLE_ACTION);
});

test("Escape and scrim close a narrow dock without cancelling the running turn", () => {
	const { elements, renderer, paint, report } = setup();
	const abort = vi.fn(); renderer.onAbort = abort;
	paint(true); escape();
	expect(report).toHaveBeenLastCalledWith({ kind: "command", id: DOCK_TOGGLE_ACTION, data: undefined });
	expect(elements.dock.hidden).toBe(true);
	expect(abort).not.toHaveBeenCalled();
	paint(true); elements.scrim.click();
	expect(elements.dock.hidden).toBe(true);
});

test("sidebar and dock drawers are mutually exclusive and keep their own close control", () => {
	const { elements, paint } = setup();
	paint(true);
	elements.sidebarToggle.click();
	expect(elements.dock.hidden).toBe(true);
	expect(document.body.classList.contains("sidebar-open")).toBe(true);
	expect(elements.sidebar.inert).toBe(false);
	expect(elements.center.inert).toBe(true);
	expect(elements.sidebar.contains(elements.sidebarToggle)).toBe(true);
	escape();
	expect(document.body.classList.contains("sidebar-open")).toBe(false);
	expect(elements.center.inert).toBe(false);
	expect(document.activeElement).toBe(elements.sidebarToggle);
	elements.sidebarToggle.click(); paint(true);
	expect(document.body.classList.contains("sidebar-open")).toBe(false);
	expect(elements.sidebar.inert).toBe(true);
});

test("wide columns do not lock the conversation or move focus when resized", () => {
	const { elements, paint } = setup();
	paint(true);
	const active = document.activeElement;
	narrow = false;
	window.dispatchEvent(new Event("resize"));
	expect(elements.center.inert).toBe(false);
	expect(elements.sidebar.inert).toBe(false);
	expect(elements.dock.inert).toBe(false);
	expect(document.activeElement).toBe(active);
	escape();
	expect(elements.dock.hidden).toBe(false);
});

test("resizing from a sidebar drawer through wide columns cannot leave overlapping drawers", () => {
	const { elements, paint } = setup();
	elements.sidebarToggle.click();
	expect(document.body.classList.contains("sidebar-open")).toBe(true);
	narrow = false;
	window.dispatchEvent(new Event("resize"));
	expect(document.body.classList.contains("sidebar-open")).toBe(false);
	paint(true);
	narrow = true;
	window.dispatchEvent(new Event("resize"));
	expect(document.body.classList.contains("sidebar-open")).toBe(false);
	expect(elements.sidebar.inert).toBe(true);
	escape();
	expect(elements.dock.hidden).toBe(true);
	expect(elements.center.inert).toBe(false);
});

test("persistent rail navigation keeps keyboard focus while a destination repaints", () => {
	const { elements, renderer, paint } = setup();
	paint(true);
	const destination = elements.nav.querySelector<HTMLButtonElement>('[data-view="plugins"]');
	if (!destination || !renderer.view) throw new Error("Missing navigation");
	destination.focus();
	const view = renderer.view;
	renderer.render({ ...view, panel: { ...view.panel, current: "plugins" } });
	expect((document.activeElement as HTMLElement).dataset.view).toBe("plugins");
	expect(elements.center.inert).toBe(false);
	expect(elements.dock.hidden).toBe(true);
});
