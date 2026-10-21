/** @vitest-environment happy-dom */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MODEL_CONNECTIONS_ACTION, MODEL_DEFAULTS_ACTION, REFRESH_MODELS_ACTION, SESSION_RENAME_ACTION } from "../src/actions.ts";
import { removeSessionModal, renameSessionModal } from "../src/panels.ts";
import { archiveSessionModal, projectGroups, toggleExpandedProjects, COMPOSER_PROJECT_ACTION, PROJECT_ADD_ACTION, PROJECT_SELECT_ACTION, SESSION_ARCHIVE_ACTION, SESSION_ARCHIVE_MODAL, SESSION_RESTORE_ACTION } from "../src/projects.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { failureView, rosterItems } from "../src/view.ts";
import {
	createModelConnections,
	MODEL_ENABLED_ACTION,
	PROVIDER_EDIT_ACTION,
	PROVIDER_SELECT_ACTION,
	PROVIDER_TEST_ACTION,
	providerConfigurationModal,
	providerTestModal,
	type ModelConnectionsLike,
} from "../src/model-connections.ts";

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
		expect(modal.fields.find(field => field.id === "id")).toBeUndefined();
		const configured = providerConfigurationModal("zh", { id: "openai", name: "OpenAI", baseUrl: "https://example.test/v1", api: "openai-completions", modelCount: 1, custom: false, configured: true, verification: { status: "idle" } }, [], [], [{ type: "api_key", label: "Key" }, { type: "oauth", label: "Login" }]);
		expect(configured.title).toBe("配置");
		expect(configured.actions).toEqual([{ id: "models:logout", data: "openai", label: "删除", weight: "line", danger: true, placement: "start" }]);
		expect(configured.fields.map(field => field.id)).toEqual(["name", "baseUrl", "api", "method:openai", "key:openai"]);
		expect(configured.fields.find(field => field.id === "key:openai")).toMatchObject({ inputType: "password", placeholder: "留空则保留已保存的密钥", visibleWhen: { field: "method:openai", values: ["api_key"] } });

		const add = providerConfigurationModal("zh", undefined, [], [
			{ id: "anthropic", name: "Anthropic", methods: [{ type: "oauth", label: "Claude" }, { type: "api_key", label: "Key" }] },
			{ id: "google", name: "Google", methods: [{ type: "api_key", label: "Key" }] },
		]);
		expect(add.title).toBe("添加供应商");
		expect(add.description).toBe("选择供应商，再用 API 密钥或登录完成配置。");
		expect(add.submit).toBe("继续");
		expect(add.fields.map(field => field.id)).toEqual(["id", "method:anthropic", "key:anthropic", "key:google"]);
		expect(add.fields[1]).toMatchObject({
			kind: "select", value: "api_key",
			options: [{ value: "api_key", label: "API 密钥" }, { value: "oauth", label: "登录凭证" }],
			visibleWhen: { field: "id", values: ["anthropic"] },
		});
		expect(add.fields[2]).toMatchObject({
			kind: "text", inputType: "password",
			visibleWhen: [{ field: "id", values: ["anthropic"] }, { field: "method:anthropic", values: ["api_key"] }],
		});
		expect(add.fields[3]).toMatchObject({ visibleWhen: { field: "id", values: ["google"] } });
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

	test("project headings expand independently of the current project", () => {
		const { renderer, view } = paint();
		const report = vi.fn();
		renderer.onPanelAction = report;
		const projects = {
			projects: [
				{ id: "a", name: "AmazMe", cwd: "/a", createdAt: 1 },
				{ id: "b", name: "PilotDeck", cwd: "/b", createdAt: 2 },
			],
			sessions: [
				{ sessionId: "sa", name: "one", cwd: "/a", createdAt: 3, projectId: "a" },
				{ sessionId: "sb", name: "two", cwd: "/b", createdAt: 4, projectId: "b" },
			],
		};
		const roster = rosterItems("zh", projects, "sa", 5);
		const open = ["a"];
		renderer.render({ ...view, locale: "zh", roster, attachedId: "sa", projects: projectGroups(projects, roster, "a", "", open) });
		const headings = [...document.querySelectorAll<HTMLButtonElement>(".project-select")];
		expect(headings.map(button => button.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
		expect(document.querySelector('[data-project-id="a"] [data-session-id="sa"]')).not.toBeNull();
		expect(document.querySelector('[data-project-id="b"] [data-session-id]')).toBeNull();
		headings[1]?.click();
		expect(report).toHaveBeenLastCalledWith({ kind: "command", id: PROJECT_SELECT_ACTION, data: "b" });
		const both = toggleExpandedProjects(open, "b");
		expect(projectGroups(projects, roster, "a", "", both)?.map(group => [group.id, group.selected, group.expanded])).toEqual([
			["a", true, true],
			["b", false, true],
		]);
		renderer.render({ ...view, locale: "zh", roster, attachedId: "sa", projects: projectGroups(projects, roster, "a", "", both) });
		expect([...document.querySelectorAll(".project-select")].map(button => button.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
		expect(document.querySelector('[data-project-id="a"] [data-session-id="sa"]')).not.toBeNull();
		expect(document.querySelector('[data-project-id="b"] [data-session-id="sb"]')).not.toBeNull();
		const closedCurrent = toggleExpandedProjects(both, "a");
		expect(projectGroups(projects, roster, "a", "", closedCurrent)?.map(group => [group.id, group.selected, group.expanded])).toEqual([
			["a", true, false],
			["b", false, true],
		]);
		expect(projectGroups(projects, roster, "a", "")?.map(group => group.expanded)).toEqual([true, false]);
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
			projects: [{ id: "p", name: "App", cwd: "/work", selected: true, expanded: true, items: [] }],
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
			projects: [{ id: "p", name: "App", cwd: "/work", selected: true, expanded: true, items: view.roster }],
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

	test("model connections workspace maintains heading hierarchy, search persistence, button weight, and row actions", () => {
		const report = vi.fn();
		const connections = createModelConnections(report);
		document.body.append(connections.element);
		const baseView: ModelConnectionsLike = {
			state: {
				providers: [
					{
						id: "anthropic",
						name: "Anthropic",
						configured: false,
						baseUrl: "https://api.anthropic.com",
						api: "anthropic-messages",
						modelCount: 2,
						custom: false,
						verification: { status: "idle" },
					},
					{
						id: "openai",
						name: "OpenAI",
						configured: true,
						baseUrl: "https://api.openai.com/v1",
						api: "openai-responses",
						modelCount: 1,
						custom: false,
						verification: { status: "success", modelId: "gpt-5", checkedAt: 1700000000000 },
					},
				],
				authentication: {
					providers: [
						{ id: "anthropic", name: "Anthropic", configured: false, methods: [{ type: "api_key", label: "API Key" }] },
						{ id: "openai", name: "OpenAI", configured: true, methods: [{ type: "api_key", label: "API Key" }] },
					],
					login: null,
				},
				enabledModelIds: ["anthropic/claude-sonnet-4", "openai/gpt-5"],
				defaults: { model: { provider: "anthropic", modelId: "claude-sonnet-4" }, thinkingLevel: "medium" },
				error: null,
				refresh: { status: "idle" },
			},
			selected: "anthropic",
			models: [
				{ provider: "anthropic", modelId: "claude-sonnet-4", name: "Claude Sonnet 4", available: true },
				{ provider: "anthropic", modelId: "claude-opus-4", name: "Claude Opus 4", available: false },
			],
			enabledModels: [
				{ provider: "anthropic", modelId: "claude-sonnet-4", name: "Claude Sonnet 4", available: true },
				{ provider: "openai", modelId: "gpt-5", name: "GPT-5", available: true },
			],
			loading: false,
			disabled: false,
		};

		connections.update("zh", baseView, [{ tone: "info", text: "已保存默认配置" }]);
		expect([...connections.element.querySelectorAll(".connection-row-name")].map(node => node.textContent)).toEqual(["OpenAI"]);
		expect(connections.element.querySelector<HTMLButtonElement>(`.connection-rail [data-action="${PROVIDER_EDIT_ACTION}"]`)?.disabled).toBe(false);
		expect(connections.element.querySelector(".panel-titles")).toBeNull();
		expect(connections.element.querySelector("h2.connection-provider-name")?.textContent).toBe("Anthropic");
		expect(connections.element.querySelector("h3.connection-models-title")?.textContent).toBe("启用模型");
		expect(connections.element.querySelector(".connection-models-count")?.textContent).toBe("1 / 2");
		expect(connections.element.querySelector(".connection-notices .panel-notice")?.textContent).toBe("已保存默认配置");

		// An unconfigured provider keeps Configure as the only filled action. Test waits until a credential exists.
		const primaryButtons = connections.element.querySelectorAll(".connection-detail .weight-filled");
		expect(primaryButtons).toHaveLength(1);
		expect(primaryButtons[0]?.textContent).toBe("配置");
		expect(connections.element.querySelector<HTMLButtonElement>(`.connection-detail [data-action="${PROVIDER_TEST_ACTION}"]`)?.disabled).toBe(true);
		expect(connections.element.querySelector(".connection-model [data-action]")).toBeNull();

		// Search input is inside a <search> landmark with autocorrect/spellcheck disabled and stays mounted across updates.
		const searchInput = connections.element.querySelector<HTMLInputElement>("search.connection-search > input.connection-search-input")!;
		expect(searchInput.getAttribute("autocorrect")).toBe("off");
		expect(searchInput.getAttribute("autocapitalize")).toBe("off");
		expect(searchInput.spellcheck).toBe(false);
		searchInput.value = "open";
		searchInput.dispatchEvent(new Event("input"));
		expect(connections.element.querySelectorAll(".connection-row")).toHaveLength(1);
		expect(connections.element.querySelector(".connection-row-name")?.textContent).toBe("OpenAI");

		// Updating to a configured provider keeps the same search input and removes primary weight from secondary actions.
		connections.update("zh", { ...baseView, selected: "openai" });
		expect(connections.element.querySelector("input.connection-search-input")).toBe(searchInput);
		expect(connections.element.querySelectorAll(".connection-detail .weight-filled")).toHaveLength(0);
		expect(connections.element.querySelector(".connection-verification.success")?.textContent).toContain("gpt-5 · 最近验证成功");
		connections.element.querySelector<HTMLButtonElement>(`.connection-detail [data-action="${PROVIDER_TEST_ACTION}"]`)!.click();
		expect(report).toHaveBeenLastCalledWith({ kind: "command", id: PROVIDER_TEST_ACTION, data: "openai" });
		const testDialog = providerTestModal("zh", [{ provider: "openai", modelId: "gpt-5", name: "GPT-5", available: true }], true);
		expect(testDialog.title).toBe("请选择要检测的模型");
		expect(testDialog.fields.map(field => [field.id, field.value])).toEqual([["model", "gpt-5"], ["key", "••••••••"]]);
		expect(testDialog.actions?.[0]).toMatchObject({ label: "检测所有模型", placement: "start" });
		expect(testDialog.submit).toBe("开始");

		// Model row interactions report expected actions; the default is set once in the overview.
		connections.update("zh", baseView);
		const firstRow = connections.element.querySelector<HTMLElement>(".connection-model")!;
		expect(firstRow.querySelector(`[data-action="${MODEL_DEFAULTS_ACTION}"]`)).toBeNull();
		const checkbox = firstRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		checkbox.checked = false;
		checkbox.dispatchEvent(new Event("change"));
		expect(report).toHaveBeenLastCalledWith({
			kind: "control",
			id: MODEL_ENABLED_ACTION,
			data: JSON.stringify(["anthropic", "claude-sonnet-4"]),
			value: "false",
		});
		expect(connections.element.querySelector(`[data-action="models:back"]`)).toBeNull();
		const defaultControls = connections.element.querySelector(".connection-overview .connection-default-controls")!;
		const refresh = defaultControls.querySelector<HTMLButtonElement>(`[data-action="${REFRESH_MODELS_ACTION}"]`)!;
		expect(refresh.textContent).toBe("刷新");
		refresh.click();
		expect(report).toHaveBeenLastCalledWith({ kind: "command", id: REFRESH_MODELS_ACTION, data: undefined });
		const defaultSelect = defaultControls.querySelector<HTMLSelectElement>(".connection-default-select")!;
		expect([...defaultSelect.querySelectorAll("optgroup")].map(group => group.label)).toEqual(["Anthropic", "OpenAI"]);
		expect(defaultSelect.value).toBe(JSON.stringify(["anthropic", "claude-sonnet-4"]));
		defaultSelect.value = JSON.stringify(["openai", "gpt-5"]);
		defaultSelect.dispatchEvent(new Event("change"));
		expect(report).toHaveBeenLastCalledWith({ kind: "command", id: MODEL_DEFAULTS_ACTION, data: JSON.stringify(["openai", "gpt-5"]) });
		connections.element.querySelector<HTMLButtonElement>(`[data-action="${PROVIDER_SELECT_ACTION}"]`)!.click();
		expect(report).toHaveBeenLastCalledWith({ kind: "command", id: PROVIDER_SELECT_ACTION, data: "openai" });
		connections.element.querySelector<HTMLButtonElement>(`.connection-rail [data-action="${PROVIDER_EDIT_ACTION}"]`)!.click();
		expect(report).toHaveBeenLastCalledWith({ kind: "command", id: PROVIDER_EDIT_ACTION, data: undefined });

		connections.update("zh", baseView, [{ tone: "error", text: "no credentials" }]);
		expect(connections.element.querySelector(".connection-notices .panel-notice.error")?.textContent).toBe("请登录供应商或检查 API 密钥");
		expect(connections.element.querySelector(".connection-notices .panel-notice.info")).toBeNull();

		// A default outside the enabled list stays visible so the current choice is not lost.
		connections.update("zh", { ...baseView, enabledModels: [] });
		const fallbackSelect = connections.element.querySelector<HTMLSelectElement>(".connection-overview .connection-default-select")!;
		expect(fallbackSelect.value).toBe(JSON.stringify(["anthropic", "claude-sonnet-4"]));
		expect([...fallbackSelect.options].map(option => option.textContent)).toEqual(["anthropic/claude-sonnet-4"]);

		// Without enabled models the overview keeps the label and explains what to do.
		connections.update("zh", { ...baseView, enabledModels: [], state: { ...baseView.state, defaults: null } });
		expect(connections.element.querySelector(".connection-default-text")?.textContent).toBe("新聊天默认模型");
		const emptySelect = connections.element.querySelector<HTMLSelectElement>(".connection-overview .connection-default-select")!;
		expect(emptySelect.disabled).toBe(true);
		expect(emptySelect.selectedOptions[0]?.textContent).toBe("添加供应商后即可选择默认模型。");

		searchInput.value = "";
		connections.update("zh", {
			...baseView,
			selected: undefined,
			state: { ...baseView.state, providers: baseView.state.providers.map(provider => ({ ...provider, configured: false })) },
		});
		expect(connections.element.querySelector(".connection-list .connection-empty")?.textContent).toBe("还没有配置过的供应商。");
		expect(connections.element.querySelector<HTMLButtonElement>(`.connection-rail [data-action="${PROVIDER_EDIT_ACTION}"]`)?.disabled).toBe(false);

		connections.update("zh", {
			...baseView,
			state: { ...baseView.state, providers: baseView.state.providers.map(provider => ({ ...provider, configured: true })) },
		});
		expect(connections.element.querySelector<HTMLButtonElement>(`.connection-rail [data-action="${PROVIDER_EDIT_ACTION}"]`)?.disabled).toBe(true);
		expect([...connections.element.querySelectorAll(".connection-row-name")].map(node => node.textContent)).toEqual(["Anthropic", "OpenAI"]);
	});
});
