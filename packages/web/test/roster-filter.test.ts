/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { DOCK_TAB_ACTION, MODEL_CONNECTIONS_ACTION, MODEL_SCOPE_ACTION, WELCOME_SESSION_ACTION } from "../src/actions.ts";
import { modelScopeModal } from "../src/model-scope.ts";
import { DIAGNOSTICS_ACTION } from "../src/panels.ts";
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
	const english = buildWebView({ ...input(""), locale: "en", showWelcome: true, directory: { sessions: [] } });
	renderer.render(english);
	expect(document.querySelector<HTMLButtonElement>(`.welcome-steps [data-action="${WELCOME_SESSION_ACTION}"]`)?.textContent).toBe(english.welcome?.steps[0]?.label);
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

test("an attached session without models offers nearby provider and model setup actions and returns to the draft", () => {
	const elements = collectPageElements();
	const renderer = createRenderer(elements);
	const report = vi.fn();
	renderer.onPanelAction = report;
	const base: WebViewInput = {
		...input(""),
		attachedId: "one",
		directory: { sessions: [{ sessionId: "one", name: "周报", cwd: "/work", createdAt: 1 }] },
		models: {
			catalog: { revision: 1, availableModels: [], enabledModelIds: null },
			configuration: { model: null, thinkingLevel: "off" },
			refresh: { status: "idle" },
		},
	};
	renderer.render(buildWebView(base));
	expect(elements.modelSelect.hidden).toBe(true);
	const picker = document.querySelector<HTMLButtonElement>(".composer-model-picker")!;
	picker.click();
	const menu = document.querySelector<HTMLDialogElement>(".model-picker-menu")!;
	expect(menu.open).toBe(true);
	expect(menu.textContent).toContain("没有可用模型。");
	menu.querySelector<HTMLButtonElement>(".model-picker-manage")!.click();
	expect(report).toHaveBeenLastCalledWith({ kind: "command", id: MODEL_CONNECTIONS_ACTION, data: undefined });
	const settingsState = {
		paths: { global: "/agent/settings.json" },
		projectTrusted: true,
		descriptors: [{ id: "compactionEnabled", group: "conversation", kind: "boolean" as const, field: "compactionEnabled", explicit: false, value: "false" }],
		errors: [],
	};
	const settingsView = { locale: "zh" as const, current: "settings" as const, settings: { hostModels: true, state: settingsState } };
	renderer.render(buildWebView({ ...base, panel: settingsView }));
	document.querySelector<HTMLButtonElement>('#section-nav [data-group-id="settings:conversation"]')!.click();
	expect(document.querySelector("#section-nav .nav-row.active")?.getAttribute("data-group-id")).toBe("settings:conversation");
	renderer.render(buildWebView(base));
	document.querySelector<HTMLButtonElement>(".composer-model-picker")!.click();
	document.querySelector<HTMLButtonElement>(".model-picker-manage")!.click();
	renderer.render(buildWebView({ ...base, panel: settingsView }));
	expect(document.querySelector("#section-nav .nav-row.active")?.getAttribute("data-group-id")).toBe("settings:models");
	renderer.render(buildWebView(base));
	expect(document.querySelector(`#transcript-empty [data-action="${MODEL_CONNECTIONS_ACTION}"]`)?.textContent).toBe("添加供应商");
	expect(document.querySelector(`#transcript-empty [data-action="${MODEL_SCOPE_ACTION}"]`)).toBeNull();
	renderer.render(buildWebView({
		...base,
		models: { ...base.models!, catalog: { ...base.models!.catalog, enabledModelIds: [] } },
	}));
	picker.click(); expect(menu.textContent).toContain("没有可用模型。"); menu.close();

	// When models exist in the catalog but the scope filter excluded all of them, offer "选择可用模型".
	const filteredOut: WebViewInput = {
		...base,
		models: {
			catalog: {
				revision: 2,
				availableModels: [{ provider: "deepseek", modelId: "v4", name: "DeepSeek V4", reasoning: false }],
				enabledModelIds: [],
			},
			configuration: { model: null, thinkingLevel: "off" },
			refresh: { status: "idle" },
		},
	};
	renderer.render(buildWebView(filteredOut));
	picker.click();
		expect(menu.textContent).toContain("列表中没有可用模型，请在设置中勾选常用模型。"); menu.close();
	expect(document.querySelector(`#transcript-empty [data-action="${MODEL_SCOPE_ACTION}"]`)?.textContent).toBe("选择可用模型");

	// Empty modelScopeModal offers a direct provider connection action instead of a dead-end 0/0 form.
	const emptyModal = modelScopeModal("zh", { allModels: [], enabledModelIds: null });
	expect(emptyModal.fields).toEqual([]);
	expect(emptyModal.actions).toEqual([{ id: MODEL_CONNECTIONS_ACTION, label: "添加供应商", weight: "filled" }]);
	expect(emptyModal.submit).toBeUndefined();
	const staleScope = modelScopeModal("zh", { allModels: [], enabledModelIds: ["deepseek/v4"] });
	expect(staleScope.fields[0]?.options).toEqual([{ value: "deepseek/v4", label: "deepseek/v4（当前不可用）" }]);
	expect(staleScope.submit).toBe("应用列表");
	expect(staleScope.actions?.[0]?.id).toBe(MODEL_CONNECTIONS_ACTION);

	// Cancelling the modal restores the draft selection once and consumes it so later edits do not jump the cursor.
	renderer.render(buildWebView(base));
	renderer.setDraft("abcdefghij");
	elements.prompt.setSelectionRange(10, 10);
	elements.prompt.dispatchEvent(new Event("select"));
	document.querySelector<HTMLButtonElement>(`#transcript-empty [data-action="${MODEL_CONNECTIONS_ACTION}"]`)?.click();
	expect(report).toHaveBeenLastCalledWith({ kind: "command", id: MODEL_CONNECTIONS_ACTION, data: undefined });

	const modal = modelScopeModal("zh", { allModels: [{ provider: "deepseek", id: "v4", name: "DeepSeek V4" }], enabledModelIds: ["deepseek/v4"] });
	renderer.render(buildWebView({ ...base, draft: "abcdefghij", panel: { ...base.panel, modal } }));
	expect(elements.modalRoot.open).toBe(true);

	// Modal closes via cancel while models are still empty.
	renderer.render(buildWebView({ ...base, draft: "abcdefghij" }));
	expect(elements.modalRoot.open).toBe(false);
	expect(document.activeElement).toBe(elements.prompt);
	expect(elements.prompt.selectionStart).toBe(10);
	expect(elements.prompt.selectionEnd).toBe(10);

	// User moves cursor to start (0, 0) and types "X", triggering a repaint, then types "Y".
	elements.prompt.setSelectionRange(0, 0);
	elements.prompt.dispatchEvent(new Event("select"));
	elements.prompt.value = "Xabcdefghij";
	elements.prompt.setSelectionRange(1, 1);
	elements.prompt.dispatchEvent(new Event("input"));
	renderer.render(buildWebView({ ...base, draft: "Xabcdefghij" }));
	expect(elements.prompt.selectionStart).toBe(1);
	expect(elements.prompt.selectionEnd).toBe(1);
	elements.prompt.value = "XYabcdefghij";
	elements.prompt.setSelectionRange(2, 2);
	elements.prompt.dispatchEvent(new Event("input"));
	renderer.render(buildWebView({ ...base, draft: "XYabcdefghij" }));
	expect(elements.prompt.selectionStart).toBe(2);
	expect(elements.prompt.selectionEnd).toBe(2);

	// Opening setup again and completing model configuration restores selection to the draft.
	elements.prompt.setSelectionRange(3, 5);
	elements.prompt.dispatchEvent(new Event("select"));
	document.querySelector<HTMLButtonElement>(`#transcript-empty [data-action="${MODEL_CONNECTIONS_ACTION}"]`)?.click();
	renderer.render(buildWebView({ ...base, draft: "XYabcdefghij", panel: { ...base.panel, modal } }));
	const configured = buildWebView({
		...base,
		draft: "XYabcdefghij",
		models: {
			catalog: { revision: 3, availableModels: [{ provider: "deepseek", modelId: "v4", name: "DeepSeek V4", reasoning: false }], enabledModelIds: ["deepseek/v4"] },
			configuration: { model: { provider: "deepseek", modelId: "v4" }, thinkingLevel: "off" },
			refresh: { status: "idle" },
		},
	});
	renderer.render(configured);
	expect(elements.modalRoot.open).toBe(false);
	expect(elements.modelSetup?.hidden).toBe(true);
	expect(picker.hidden).toBe(false);
	expect(picker.disabled).toBe(false);
	expect(picker.textContent).toContain("DeepSeek V4");
	expect(elements.prompt.value).toBe("XYabcdefghij");
	expect(document.activeElement).toBe(elements.prompt);
	expect(elements.prompt.selectionStart).toBe(3);
	expect(elements.prompt.selectionEnd).toBe(5);
});

test("settings modals restore their trigger while retaining the composer's return selection", () => {
	const elements = collectPageElements();
	const renderer = createRenderer(elements);
	const base = { ...input(""), attachedId: "one", draft: "abcdefghij" };
	renderer.render(buildWebView(base));
	renderer.setDraft(base.draft);
	elements.prompt.setSelectionRange(3, 5);
	elements.prompt.dispatchEvent(new Event("select"));
	const settings: WebViewInput = {
		...base,
		panel: { locale: "zh", current: "settings", settings: { state: {
			paths: { global: "/agent/settings.json" }, projectTrusted: false, errors: [], descriptors: [],
		} } },
	};
	renderer.render(buildWebView(settings));
	const trigger = document.querySelector<HTMLButtonElement>(`[data-action="${DIAGNOSTICS_ACTION}"]`)!;
	trigger.focus();
	renderer.render(buildWebView({ ...settings, panel: { ...settings.panel, modal: { id: "diagnostics", title: "诊断", fields: [] } } }));
	renderer.render(buildWebView(settings));
	expect(document.activeElement).toBe(trigger);
	renderer.render(buildWebView(base));
	expect(document.activeElement).toBe(elements.prompt);
	expect(elements.prompt.selectionStart).toBe(3);
	expect(elements.prompt.selectionEnd).toBe(5);
});
