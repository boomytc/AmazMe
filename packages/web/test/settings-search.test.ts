/**
 * @vitest-environment happy-dom
 */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { buildWebView, type WebViewInput } from "../src/view.ts";

function shell(panel: WebViewInput["panel"]): WebViewInput {
	return {
		locale: "zh",
		submitMode: "followUp",
		attachments: [],
		rosterFilter: "",
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
		dock: {
			open: false,
			tab: "files",
			cwd: "",
			workspace: undefined,
			terminal: undefined,
			conversations: undefined,
		},
		panel,
		directory: undefined,
		transcript: undefined,
		attachedId: undefined,
		now: 0,
		models: undefined,
		thinkingLevels: [],
	};
}

const chat = shell({ locale: "zh", current: "chat" });
const settings = shell({
	locale: "zh",
	current: "settings",
	settings: {
		state: {
			paths: { global: "/agent/settings.json", project: "/project/.amazme/settings.json" },
			projectTrusted: true,
			descriptors: [
				{
					id: "steeringMode",
					group: "conversation",
					kind: "enum",
					field: "steeringMode",
					explicit: true,
					value: "all",
					options: ["one-at-a-time", "all"],
				},
				{
					id: "compactionEnabled",
					group: "conversation",
					kind: "boolean",
					field: "compactionEnabled",
					explicit: false,
					value: "false",
				},
				{ id: "shellPath", group: "shell", kind: "string", field: "shellPath", explicit: true, value: "" },
			],
			errors: [],
		},
	},
});

let cleanupListeners = (): void => {};

test("font size controls enforce the Host's upper bound, preview typography live, and report save timing and completion", () => {
	const descriptors = [
		{ id: "textFont", group: "interface", kind: "string" as const, field: "typography.textFont", explicit: false, value: "" },
		{ id: "codeSize", group: "interface", kind: "number" as const, field: "typography.codeSize", explicit: false, value: "13", min: 10, max: 16, step: 1 },
	];
	const input = shell({ locale: "zh", current: "settings", settings: { state: {
		paths: { global: "/agent/settings.json" }, projectTrusted: false, errors: [],
		descriptors,
	} } });
	const renderer = createRenderer(collectPageElements());
	const action = vi.fn();
	renderer.onPanelAction = action;
	renderer.render(buildWebView(input));
	const fontControl = document.querySelector<HTMLInputElement>('input[aria-label="正文字体"]');
	const control = document.querySelector<HTMLInputElement>('input[aria-label="代码字号（px）"]');
	const preview = document.querySelector<HTMLElement>("[data-typography-preview]");
	if (!control || !fontControl || !preview) throw new Error("Missing typography controls or preview");
	const statusOf = () => control.closest(".panel-field")?.querySelector<HTMLElement>(".panel-field-status");
	expect(statusOf()?.textContent).toBe("按 Enter 或失焦保存");
	expect(preview.style.getPropertyValue("--code-font-size")).toBe("13px");

	fontControl.value = "Georgia";
	fontControl.dispatchEvent(new Event("input", { bubbles: true }));
	expect(preview.style.getPropertyValue("--font-content")).toBe('"Georgia", var(--font-sans)');

	expect(control.max).toBe("16");
	control.value = "17";
	control.dispatchEvent(new Event("change", { bubbles: true }));
	expect(action).not.toHaveBeenCalled();
	expect(control.getAttribute("aria-invalid")).toBe("true");
	expect(statusOf()?.hidden).toBe(true);

	control.value = "16";
	control.dispatchEvent(new Event("input", { bubbles: true }));
	expect(preview.style.getPropertyValue("--code-font-size")).toBe("16px");
	expect(statusOf()?.hidden).toBe(false);
	expect(statusOf()?.dataset.state).toBe("dirty");

	control.dispatchEvent(new Event("change", { bubbles: true }));
	expect(action).toHaveBeenCalledWith(expect.objectContaining({ data: "codeSize", value: "16" }));
	expect(statusOf()?.textContent).toBe("正在保存…");
	expect(statusOf()?.dataset.state).toBe("saving");

	const settled = shell({ locale: "zh", current: "settings", settings: { state: {
		paths: { global: "/agent/settings.json" }, projectTrusted: false, errors: [],
		descriptors: [descriptors[0]!, { ...descriptors[1]!, value: "16", explicit: true }],
	} } });
	renderer.render(buildWebView(settled));
	const settledStatus = document.querySelector<HTMLInputElement>('input[aria-label="代码字号（px）"]')
		?.closest(".panel-field")
		?.querySelector<HTMLElement>(".panel-field-status");
	expect(settledStatus?.textContent).toBe("已保存");
	expect(settledStatus?.dataset.state).toBe("saved");
});

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	const body = html.slice(html.indexOf("<body>") + "<body>".length, html.lastIndexOf("</body>"));
	document.body.className = "";
	document.body.innerHTML = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
	const documentListeners = vi.spyOn(document, "addEventListener");
	const windowListeners = vi.spyOn(window, "addEventListener");
	cleanupListeners = () => {
		for (const [type, listener, options] of documentListeners.mock.calls) document.removeEventListener(type, listener, options);
		for (const [type, listener, options] of windowListeners.mock.calls) window.removeEventListener(type, listener, options);
	};
});

afterEach(() => {
	cleanupListeners();
	vi.restoreAllMocks();
});

describe("settings page", () => {
	test("keeps the category column open and searches settings into that category", () => {
		document.body.classList.add("sidebar-collapsed");
		const elements = collectPageElements();
		const inertAtFocus: boolean[] = [];
		elements.sectionSearchInput.addEventListener("focus", () => inertAtFocus.push(elements.sidebar.inert));
		const renderer = createRenderer(elements);
		renderer.render(buildWebView(chat));
		expect(elements.sidebar.inert).toBe(true);
		expect(elements.sidebarToggle.closest("#session-sidebar")).toBeNull();
		expect(elements.sidebarToggle.closest(".header")).not.toBeNull();
		renderer.render(buildWebView(settings));
		expect(elements.sidebar.inert).toBe(false);
		expect(document.activeElement).toBe(elements.sectionSearchInput);
		expect(inertAtFocus).toEqual([false]);

		const toggle = elements.sidebarToggle;
		expect(toggle).toBeInstanceOf(HTMLButtonElement);
		expect(document.body.classList.contains("settings-open")).toBe(true);
		expect(document.body.classList.contains("sidebar-collapsed")).toBe(false);
		expect(document.getElementById("view-back")?.hidden).toBe(true);
		expect(document.getElementById("session-title")?.hidden).toBe(true);
		expect((toggle as HTMLButtonElement).hidden).toBe(true);
		(toggle as HTMLButtonElement).click();
		expect(document.body.classList.contains("sidebar-collapsed")).toBe(false);

		const search = document.getElementById("section-search");
		const input = document.getElementById("section-search-input");
		const clear = document.getElementById("section-search-clear");
		expect(search?.hidden).toBe(false);
		expect(input).toBeInstanceOf(HTMLInputElement);
		expect(clear).toBeInstanceOf(HTMLButtonElement);
		const field = input as HTMLInputElement;
		field.value = "自动压缩";
		field.dispatchEvent(new Event("input"));
		expect((clear as HTMLButtonElement).hidden).toBe(false);
		const result = document.querySelector("#section-nav button");
		expect(result?.textContent).toContain("自动压缩");
		expect(result?.textContent).toContain("对话");
		expect(result?.getAttribute("aria-label")).toBe("自动压缩，对话");
		(result as HTMLButtonElement).click();
		expect(document.querySelector(".panel-title")?.textContent).toBe("对话");
		expect(document.querySelector("#view-body [data-row-id='setting:compactionEnabled']")).not.toBeNull();

		field.value = "没有这个设置";
		field.dispatchEvent(new Event("input"));
		expect(document.getElementById("section-nav")?.textContent).toContain("没有匹配的设置");
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(field.value).toBe("");
		expect(document.querySelector("#section-nav button")?.textContent).toContain("对话");

		field.blur();
		document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF", metaKey: true, bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(field);

		renderer.render(buildWebView(chat));
		expect(document.body.classList.contains("settings-open")).toBe(false);
		expect(document.body.classList.contains("sidebar-collapsed")).toBe(true);
		expect((toggle as HTMLButtonElement).hidden).toBe(false);
		expect(toggle.closest(".header")).not.toBeNull();
		(toggle as HTMLButtonElement).click();
		expect(document.body.classList.contains("sidebar-collapsed")).toBe(false);
		expect(toggle.closest("#session-sidebar")).toBe(elements.sessionSidebar);
		(toggle as HTMLButtonElement).click();
		expect(document.body.classList.contains("sidebar-collapsed")).toBe(true);
		expect(toggle.closest(".header")).not.toBeNull();
		expect(document.getElementById("view-back")?.hidden).toBe(true);
		expect(document.getElementById("session-title")?.hidden).toBe(false);

		renderer.render(buildWebView(shell({ locale: "zh", current: "plugins" })));
		expect(document.body.classList.contains("settings-open")).toBe(false);
		expect(elements.sidebarToggle.closest(".header")).not.toBeNull();
		(toggle as HTMLButtonElement).click();
		expect(document.body.classList.contains("sidebar-collapsed")).toBe(false);
		expect(toggle.closest("#section-sidebar")).toBe(elements.sectionSidebar);
		(toggle as HTMLButtonElement).click();
		expect(document.body.classList.contains("sidebar-collapsed")).toBe(true);
		expect(toggle.closest(".header")).not.toBeNull();
		expect(document.getElementById("section-search")?.hidden).toBe(true);
		expect(document.getElementById("view-back")?.hidden).toBe(true);
		expect(document.getElementById("session-title")?.hidden).toBe(true);
		expect((toggle as HTMLButtonElement).hidden).toBe(false);

		renderer.render(buildWebView(shell({ locale: "zh", current: "skills" })));
		expect(document.getElementById("view-back")?.hidden).toBe(true);
		expect(document.getElementById("session-title")?.hidden).toBe(true);

		renderer.render(buildWebView(shell({ locale: "zh", current: "automation" })));
		expect(document.getElementById("view-back")?.hidden).toBe(false);
		expect(document.getElementById("session-title")?.hidden).toBe(false);
		expect(document.getElementById("session-title")?.textContent).toBe("自动化");
	});

	test.each([
		{ name: "Cmd+F", metaKey: true, ctrlKey: false },
		{ name: "Ctrl+F", metaKey: false, ctrlKey: true },
	])("opens the narrow settings drawer before focusing search with $name", ({ metaKey, ctrlKey }) => {
		const matchMedia = window.matchMedia.bind(window);
		vi.spyOn(window, "matchMedia").mockImplementation((query) => {
			const media = matchMedia(query);
			Object.defineProperty(media, "matches", { value: query === "(max-width: 1023px)" });
			return media;
		});
		const elements = collectPageElements();
		const focusStates: { inert: boolean; open: boolean }[] = [];
		elements.sectionSearchInput.addEventListener("focus", () => {
			focusStates.push({ inert: elements.sidebar.inert, open: document.body.classList.contains("sidebar-open") });
		});
		const renderer = createRenderer(elements);
		renderer.render(buildWebView(chat));
		renderer.render(buildWebView(settings));
		expect(elements.sidebarToggle.hidden).toBe(false);
		expect(document.body.classList.contains("sidebar-open")).toBe(false);
		expect(elements.sidebar.inert).toBe(true);
		expect(focusStates).toEqual([]);

		const field = elements.sectionSearchInput;
		field.value = "自动压缩";
		field.dispatchEvent(new Event("input"));
		const find = (): KeyboardEvent => {
			const event = new KeyboardEvent("keydown", { code: "KeyF", metaKey, ctrlKey, bubbles: true, cancelable: true });
			document.dispatchEvent(event);
			return event;
		};
		expect(find().defaultPrevented).toBe(true);
		expect(document.body.classList.contains("sidebar-open")).toBe(true);
		expect(elements.sidebar.inert).toBe(false);
		expect(elements.sidebarToggle.getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement).toBe(field);
		expect(field.selectionStart).toBe(0);
		expect(field.selectionEnd).toBe(field.value.length);
		expect(focusStates).toEqual([{ inert: false, open: true }]);

		find();
		expect(document.body.classList.contains("sidebar-open")).toBe(true);
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(field.value).toBe("");
		expect(document.body.classList.contains("sidebar-open")).toBe(true);
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(document.body.classList.contains("sidebar-open")).toBe(false);
		expect(elements.sidebar.inert).toBe(true);
		expect(document.activeElement).toBe(elements.sidebarToggle);

		find();
		expect(document.body.classList.contains("sidebar-open")).toBe(true);
		expect(elements.sidebar.inert).toBe(false);
		expect(document.activeElement).toBe(field);
		renderer.render(buildWebView(chat));
		expect(find().defaultPrevented).toBe(false);
	});
});
