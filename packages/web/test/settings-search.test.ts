/**
 * @vitest-environment happy-dom
 */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SETTINGS_FIELD_ACTION } from "../src/panels.ts";
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

test("an unacknowledged save ends with a retryable draft after pending clears", () => {
	const state = {
		paths: { global: "/agent/settings.json" }, projectTrusted: false, errors: [],
		descriptors: [{ id: "textFont", group: "interface", kind: "string" as const, field: "typography.textFont", explicit: false, value: "" }],
	};
	const renderer = createRenderer(collectPageElements());
	const action = vi.fn();
	renderer.onPanelAction = action;
	const paint = (pending = false) => renderer.render(buildWebView(shell({
		locale: "zh", current: "settings", settings: { state },
		...(pending ? { pending: { id: SETTINGS_FIELD_ACTION, data: "textFont" } } : {}),
	})));
	const field = () => document.querySelector<HTMLInputElement>('input[aria-label="正文字体"]')!;
	const status = () => field().closest(".panel-field")?.querySelector<HTMLElement>(".panel-field-status");
	paint();
	field().value = "Georgia";
	field().dispatchEvent(new Event("input"));
	field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
	paint(true);
	expect(field().disabled).toBe(true);
	expect(status()?.dataset.state).toBe("saving");
	paint();
	expect(field().disabled).toBe(false);
	expect(field().value).toBe("Georgia");
	expect(status()?.dataset.state).toBe("dirty");
	field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
	expect(action).toHaveBeenCalledTimes(2);
	expect(action).toHaveBeenLastCalledWith({ kind: "control", id: SETTINGS_FIELD_ACTION, data: "textFont", value: "Georgia" });
});

test("a saved confirmation cannot overwrite a newer font draft when its timer expires", () => {
	vi.useFakeTimers();
	try {
		const descriptor = { id: "textFont", group: "interface", kind: "string" as const, field: "typography.textFont", explicit: false, value: "" };
		const renderer = createRenderer(collectPageElements());
		const paint = (value: string) => renderer.render(buildWebView(shell({
			locale: "zh", current: "settings", settings: { state: {
				paths: { global: "/agent/settings.json" }, projectTrusted: false, errors: [], descriptors: [{ ...descriptor, value }],
			} },
		})));
		const field = () => document.querySelector<HTMLInputElement>('input[aria-label="正文字体"]')!;
		const status = () => field().closest(".panel-field")?.querySelector<HTMLElement>(".panel-field-status");
		paint("");
		field().value = "Georgia";
		field().dispatchEvent(new Event("input"));
		field().dispatchEvent(new Event("change"));
		paint("Georgia");
		expect(status()?.dataset.state).toBe("saved");
		field().value = "Palatino";
		field().dispatchEvent(new Event("input"));
		expect(status()?.dataset.state).toBe("dirty");
		vi.advanceTimersByTime(2400);
		expect(status()?.dataset.state).toBe("dirty");
		expect(field().value).toBe("Palatino");
	} finally {
		vi.useRealTimers();
	}
});

test("font size controls enforce the Host's upper bound, preview typography live, and report save timing and completion", () => {
	vi.useFakeTimers();
	try {
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
		const statusOf = () =>
			document
				.querySelector<HTMLInputElement>('input[aria-label="代码字号（px）"]')
				?.closest(".panel-field")
				?.querySelector<HTMLElement>(".panel-field-status");
		expect(statusOf()?.textContent).toBe("按 Enter 或失焦保存");
		expect(preview.style.getPropertyValue("--code-font-size")).toBe("13px");

		fontControl.value = "  Georgia  ";
		fontControl.dispatchEvent(new Event("input", { bubbles: true }));
		expect(preview.style.getPropertyValue("--font-content")).toBe('"Georgia", var(--font-sans)');
		fontControl.dispatchEvent(new Event("change", { bubbles: true }));
		expect(action).toHaveBeenCalledWith(expect.objectContaining({ data: "textFont", value: "Georgia" }));

		// Simulate a write failure where the host keeps the old value and reports an error notice.
		const failedWrite = shell({
			locale: "zh",
			current: "settings",
			notice: { tone: "error", text: "EACCES: permission denied" },
			settings: {
				state: {
					paths: { global: "/agent/settings.json" },
					projectTrusted: false,
					errors: [{ scope: "global", path: "/agent/settings.json", message: "EACCES: permission denied" }],
					descriptors,
				},
			},
		});
		renderer.render(buildWebView(failedWrite));
		const failedFontInput = document.querySelector<HTMLInputElement>('input[aria-label="正文字体"]');
		const failedFontStatus = failedFontInput?.closest(".panel-field")?.querySelector<HTMLElement>(".panel-field-status");
		expect(document.querySelector(".panel-notice.error")?.textContent).toContain("没有权限访问此路径");
		expect(failedFontInput?.value).toBe("Georgia");
		expect(failedFontStatus?.textContent).toBe("按 Enter 或失焦保存");
		expect(failedFontStatus?.dataset.state).toBe("dirty");

		// Retrying on the same input after the failure re-emits the normalized value.
		failedFontInput?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		expect(action).toHaveBeenCalledTimes(2);
		expect(action).toHaveBeenLastCalledWith(expect.objectContaining({ data: "textFont", value: "Georgia" }));

		expect(control.max).toBe("16");
		const currentControl = document.querySelector<HTMLInputElement>('input[aria-label="代码字号（px）"]')!;
		currentControl.value = "17";
		currentControl.dispatchEvent(new Event("change", { bubbles: true }));
		expect(action).toHaveBeenCalledTimes(2);
		expect(currentControl.getAttribute("aria-invalid")).toBe("true");
		expect(statusOf()?.hidden).toBe(true);

		currentControl.value = "16";
		currentControl.dispatchEvent(new Event("input", { bubbles: true }));
		const currentPreview = document.querySelector<HTMLElement>("[data-typography-preview]")!;
		expect(currentPreview.style.getPropertyValue("--code-font-size")).toBe("16px");
		expect(statusOf()?.hidden).toBe(false);
		expect(statusOf()?.dataset.state).toBe("dirty");

		currentControl.dispatchEvent(new Event("change", { bubbles: true }));
		expect(action).toHaveBeenCalledWith(expect.objectContaining({ data: "codeSize", value: "16" }));
		expect(statusOf()?.textContent).toBe("正在保存…");
		expect(statusOf()?.dataset.state).toBe("saving");

		const settled = shell({ locale: "zh", current: "settings", settings: { state: {
			paths: { global: "/agent/settings.json" }, projectTrusted: false, errors: [],
			descriptors: [
				{ ...descriptors[0]!, value: "Georgia", explicit: true },
				{ ...descriptors[1]!, value: "16", explicit: true },
			],
		} } });
		renderer.render(buildWebView(settled));
		const settledFontInput = document.querySelector<HTMLInputElement>('input[aria-label="正文字体"]');
		const settledFontStatus = settledFontInput?.closest(".panel-field")?.querySelector<HTMLElement>(".panel-field-status");
		expect(settledFontInput?.value).toBe("Georgia");
		expect(settledFontStatus?.textContent).toBe("已保存");
		expect(settledFontStatus?.dataset.state).toBe("saved");
		const settledStatus = document.querySelector<HTMLInputElement>('input[aria-label="代码字号（px）"]')
			?.closest(".panel-field")
			?.querySelector<HTMLElement>(".panel-field-status");
		expect(settledStatus?.textContent).toBe("已保存");
		expect(settledStatus?.dataset.state).toBe("saved");

		// After 2.4s the "已保存" confirmation automatically clears back to the commit hint in the DOM.
		vi.advanceTimersByTime(2400);
		expect(settledFontStatus?.textContent).toBe("按 Enter 或失焦保存");
		expect(settledFontStatus?.dataset.state).toBe("hint");
		expect(settledStatus?.textContent).toBe("按 Enter 或失焦保存");
		expect(settledStatus?.dataset.state).toBe("hint");
	} finally {
		vi.useRealTimers();
	}
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
		const renderer = createRenderer(elements);
		renderer.render(buildWebView(chat));
		expect(elements.sidebar.inert).toBe(true);
		expect(elements.sidebarToggle.closest("#session-sidebar")).toBeNull();
		expect(elements.sidebarToggle.closest(".header")).not.toBeNull();
		renderer.render(buildWebView(settings));
		expect(elements.center.inert).toBe(false);
		expect(document.activeElement).toBe(elements.sectionSearchInput);
		expect(document.getElementById("library-nav")?.hidden).toBe(false);

		const toggle = elements.sidebarToggle;
		expect(toggle).toBeInstanceOf(HTMLButtonElement);
		expect(document.body.classList.contains("library-open")).toBe(true);
		expect(document.body.classList.contains("sidebar-collapsed")).toBe(true);
		expect(document.getElementById("view-back")?.hidden).toBe(false);
		expect(document.getElementById("session-title")?.hidden).toBe(true);
		expect((toggle as HTMLButtonElement).hidden).toBe(true);

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
		expect(document.body.classList.contains("library-open")).toBe(false);
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
		expect(document.body.classList.contains("library-open")).toBe(true);
		expect(document.body.classList.contains("sidebar-collapsed")).toBe(true);
		expect(document.getElementById("library-nav")?.hidden).toBe(true);
		expect(document.getElementById("section-search")?.hidden).toBe(true);
		expect(document.getElementById("view-back")?.hidden).toBe(false);
		expect(document.getElementById("session-title")?.hidden).toBe(true);
		expect((toggle as HTMLButtonElement).hidden).toBe(true);

		renderer.render(buildWebView(shell({ locale: "zh", current: "skills" })));
		expect(document.getElementById("view-back")?.hidden).toBe(false);
		expect(document.getElementById("session-title")?.hidden).toBe(true);

		renderer.render(buildWebView(shell({ locale: "zh", current: "automation" })));
		expect(document.getElementById("view-back")?.hidden).toBe(false);
		expect(document.getElementById("session-title")?.hidden).toBe(true);
		expect(document.querySelector("#view-body .panel-title")?.textContent).toBe("自动化");
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
		expect(document.body.classList.contains("sidebar-open")).toBe(false);
		expect(document.activeElement).toBe(field);
		expect(field.selectionStart).toBe(0);
		expect(field.selectionEnd).toBe(field.value.length);
		expect(focusStates).toEqual([{ inert: true, open: false }]);

		find();
		expect(document.body.classList.contains("sidebar-open")).toBe(false);
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(field.value).toBe("");
		expect(document.body.classList.contains("sidebar-open")).toBe(false);

		find();
		expect(document.body.classList.contains("sidebar-open")).toBe(false);
		expect(document.activeElement).toBe(field);
		renderer.render(buildWebView(chat));
		// The conversation owns the find chord too, opening its own search bar.
		const chatFind = find();
		expect(chatFind.defaultPrevented).toBe(true);
		expect(elements.transcriptSearch.hidden).toBe(false);
		expect(document.activeElement).toBe(elements.transcriptSearchInput);
	});
});
