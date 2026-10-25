/** @vitest-environment happy-dom */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dockView } from "../src/dock.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { failureView } from "../src/view.ts";

let cleanupListeners = (): void => {};
beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.className = "";
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
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
	const paint = (open: boolean) => {
		renderer.render({ ...failureView("en", ""), attachedId: "one", newSession: { enabled: true },
			dock: dockView("en", { open, tab: "files", cwd: "/work", workspace: undefined, terminal: undefined, conversations: undefined }) });
	};
	paint(false);
	return { elements, renderer, paint };
}

test("persistent rail navigation keeps keyboard focus while a destination repaints", () => {
	const { elements, renderer, paint } = setup();
	paint(true);
	const destination = elements.nav.querySelector<HTMLButtonElement>('[data-view="plugins"]');
	if (!destination || !renderer.view) throw new Error("Missing navigation");
	destination.focus();
	const view = renderer.view;
	renderer.render({ ...view, panel: { ...view.panel, current: "plugins" } });
	expect((document.activeElement as HTMLElement).dataset.view).toBe("plugins");
	expect(elements.dock.hidden).toBe(true);
});