import type { Locale } from "./locale.ts";
import type { PanelAction, PanelModal, PanelNotice } from "./panels.ts";
import type { ProviderAuthLike } from "./provider-auth.ts";
import { MODEL_DEFAULTS_ACTION, REFRESH_MODELS_ACTION } from "./actions.ts";
import { errorMessageCopy } from "./errors.ts";
import { translate } from "./strings.ts";

export const MODEL_CONNECTIONS_ACTION = "models:connections";
export const PROVIDER_SELECT_ACTION = "models:provider";
export const PROVIDER_EDIT_ACTION = "models:edit-provider";
export const PROVIDER_EDIT_MODAL = "models:save-provider";
export const PROVIDER_TEST_ACTION = "models:test";
export const PROVIDER_TEST_MODAL = "models:test-models";
export const PROVIDER_TEST_ALL_ACTION = "models:test-all";
export const MODEL_ENABLED_ACTION = "models:enabled";

export interface ConnectionModelLike {
	readonly provider: string;
	readonly modelId: string;
	readonly name: string;
	readonly available: boolean;
}
export interface ModelConnectionsLike {
	readonly state: {
		readonly providers: readonly {
			readonly id: string; readonly name: string; readonly configured: boolean;
			readonly baseUrl: string; readonly api: string; readonly modelCount: number; readonly custom: boolean;
			readonly modelIds?: readonly string[];
			readonly verification: { readonly status: "idle" | "checking" | "success" | "error"; readonly checkedAt?: number; readonly modelId?: string };
		}[];
		readonly authentication: ProviderAuthLike;
		readonly enabledModelIds: readonly string[] | null;
		readonly defaults: { readonly model: { readonly provider: string; readonly modelId: string }; readonly thinkingLevel: string } | null;
		readonly error: string | null;
		readonly refresh: { readonly status: "idle" | "refreshing" | "done" | "warning"; readonly errors?: Readonly<Record<string, string>> };
	};
	readonly selected?: string;
	readonly models: readonly ConnectionModelLike[];
	/** Every model currently offered to new chats, across providers. */
	readonly enabledModels: readonly ConnectionModelLike[];
	readonly loading: boolean;
	readonly disabled: boolean;
}

const credentialOrder = (type: "api_key" | "oauth") => type === "api_key" ? 0 : 1;

/** The same line the provider detail and the test dialog use for a check. */
export function verificationStatusText(locale: Locale, verification: { readonly status: "idle" | "checking" | "success" | "error"; readonly checkedAt?: number; readonly modelId?: string }, modelId?: string): string {
	const label = translate(locale, verification.status === "success" ? "connections.verified" : verification.status === "error" ? "connections.failed" : verification.status === "checking" ? "connections.testing" : "connections.untested");
	const name = modelId ?? verification.modelId;
	const when = verification.checkedAt === undefined ? undefined : new Date(verification.checkedAt).toLocaleString(locale);
	return [name, label, when].filter((part): part is string => part !== undefined && part.length > 0).join(" · ");
}
const EDITABLE_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
type CredentialMethod = { readonly type: "api_key" | "oauth"; readonly label: string };

export function providerConfigurationModal(locale: Locale, provider?: ModelConnectionsLike["state"]["providers"][number], models: readonly ConnectionModelLike[] = [], presets: readonly { readonly id: string; readonly name: string; readonly methods: readonly CredentialMethod[] }[] = [], methods: readonly CredentialMethod[] = []): PanelModal {
	const copy = (key: Parameters<typeof translate>[1]) => translate(locale, key);
	if (provider === undefined) {
		const choices = presets.filter(item => item.methods.length > 0);
		const methodLabel = (type: "api_key" | "oauth") => copy(type === "api_key" ? "connections.apiKey" : "connections.signIn");
		return {
			id: PROVIDER_EDIT_MODAL, title: copy("connections.add"), description: copy("connections.choosePreset"), submit: copy("auth.continue"),
			fields: [
				{ id: "id", label: copy("connections.provider"), kind: "select", value: choices[0]?.id ?? "", options: choices.map(item => ({ value: item.id, label: item.name })) },
				...choices.filter(item => item.methods.length > 1).map(item => {
					const methods = [...item.methods].sort((left, right) => credentialOrder(left.type) - credentialOrder(right.type));
					return {
						id: `method:${item.id}`, label: copy("connections.method"), kind: "select" as const, value: methods[0]?.type ?? "api_key",
						options: methods.map(method => ({ value: method.type, label: methodLabel(method.type) })),
						visibleWhen: { field: "id", values: [item.id] },
					};
				}),
				...choices.filter(item => item.methods.some(method => method.type === "api_key")).map(item => ({
					id: `key:${item.id}`, label: copy("connections.apiKey"), kind: "text" as const, inputType: "password" as const, value: "",
					visibleWhen: item.methods.length > 1
						? [{ field: "id", values: [item.id] }, { field: `method:${item.id}`, values: ["api_key"] }]
						: { field: "id", values: [item.id] },
				})),
			],
		};
	}
	const editable = EDITABLE_APIS.includes(provider.api);
	const ordered = [...methods].sort((left, right) => credentialOrder(left.type) - credentialOrder(right.type));
	const methodLabel = (type: "api_key" | "oauth") => copy(type === "api_key" ? "connections.apiKey" : "connections.signIn");
	const onlyLogin = !editable && ordered.length > 0 && ordered.every(method => method.type === "oauth");
	return { id: PROVIDER_EDIT_MODAL, data: provider.id, title: copy("connections.configure"), submit: copy(onlyLogin ? "auth.continue" : "modal.save"), fields: [
		...(editable ? [
			{ id: "name", label: copy("connections.name"), kind: "text" as const, value: provider.name },
			{ id: "baseUrl", label: copy("connections.endpoint"), kind: "text" as const, value: provider.baseUrl },
			{ id: "api", label: copy("connections.protocol"), kind: "select" as const, value: provider.api, options: [
				{ value: "openai-completions", label: "OpenAI Chat Completions" }, { value: "openai-responses", label: "OpenAI Responses" },
				{ value: "anthropic-messages", label: "Anthropic Messages" }, { value: "google-generative-ai", label: "Google Generative AI" },
			] },
			...(provider.custom ? [{ id: "models", label: copy("connections.modelIds"), kind: "textarea" as const, value: (provider.modelIds ?? models.map(model => model.modelId)).join("\n") }] : []),
		] : []),
		...(ordered.length > 1 ? [{
			id: `method:${provider.id}`, label: copy("connections.method"), kind: "select" as const, value: ordered[0]?.type ?? "api_key",
			options: ordered.map(method => ({ value: method.type, label: methodLabel(method.type) })),
		}] : []),
		...(ordered.some(method => method.type === "api_key") ? [{
			id: `key:${provider.id}`, label: copy("connections.apiKey"), kind: "text" as const, inputType: "password" as const, value: "",
			...(provider.configured ? { placeholder: copy("connections.keyKeep") } : {}),
			...(ordered.length > 1 ? { visibleWhen: { field: `method:${provider.id}`, values: ["api_key"] } } : {}),
		}] : []),
	] };
}

/** The test dialog checks one selected model, or every model of this provider. The key is never copied here. */
export function providerTestModal(locale: Locale, models: readonly ConnectionModelLike[], configured: boolean): PanelModal {
	const copy = (key: Parameters<typeof translate>[1]) => translate(locale, key);
	return {
		id: PROVIDER_TEST_MODAL, title: copy("connections.testTitle"), submit: copy("connections.testStart"), dismiss: copy("panel.cancel"),
		actions: [{ id: PROVIDER_TEST_ALL_ACTION, label: copy("connections.testAll"), weight: "line", placement: "start", disabled: models.length === 0 }],
		fields: [
			{ id: "model", label: copy("connections.testModel"), kind: "select", value: models[0]?.modelId ?? "", options: models.map(model => ({ value: model.modelId, label: model.name })) },
			{ id: "key", label: copy("connections.apiKey"), kind: "text", readOnly: true, value: configured ? "••••••••" : copy("connections.keyMissing") },
		],
	};
}

/** The provider search stays mounted while connection and model states change. */
export function createModelConnections(report: (action: PanelAction) => void) {
	const root = document.createElement("section"); root.className = "panel model-connections split-workspace";

	const notices = document.createElement("div"); notices.className = "connection-notices"; notices.hidden = true;
	const overview = document.createElement("div"); overview.className = "connection-overview";
	const workspace = document.createElement("div"); workspace.className = "connection-workspace";

	const rail = document.createElement("aside"); rail.className = "connection-rail";
	const railHead = document.createElement("div"); railHead.className = "connection-rail-head";
	const searchBox = document.createElement("search"); searchBox.className = "connection-search";
	const search = document.createElement("input"); search.type = "search"; search.className = "connection-search-input";
	search.autocomplete = "off"; search.spellcheck = false;
	search.setAttribute("autocorrect", "off"); search.setAttribute("autocapitalize", "off");
	searchBox.append(search);
	const add = document.createElement("button"); add.type = "button"; add.className = "panel-button weight-line connection-add-button";
	add.dataset.action = PROVIDER_EDIT_ACTION;
	add.addEventListener("click", () => report({ kind: "command", id: PROVIDER_EDIT_ACTION, data: undefined }));
	railHead.append(searchBox, add);
	const list = document.createElement("div"); list.className = "connection-list";
	rail.append(railHead, list);

	const detail = document.createElement("div"); detail.className = "connection-detail";
	workspace.append(rail, detail);
	root.append(notices, overview, workspace);

	let current: ModelConnectionsLike | undefined;
	let locale: Locale = "en";
	const copy = (key: Parameters<typeof translate>[1], values?: Record<string, string>) => translate(locale, key, values);
	const node = (tag: string, text: string, className?: string) => {
		const result = document.createElement(tag);
		if (className) result.className = className;
		result.textContent = text;
		return result;
	};
	const action = (label: string, id: string, data?: string, disabled = false, className = "panel-button weight-line") => {
		const control = document.createElement("button"); control.type = "button"; control.className = className; control.textContent = label;
		control.dataset.action = id;
		if (data !== undefined) control.dataset.actionData = data;
		control.disabled = current?.disabled === true || disabled;
		control.addEventListener("click", () => report({ kind: "command", id, data }));
		return control;
	};
	const renderList = () => {
		list.replaceChildren();
		const query = search.value.trim().toLowerCase();
		const configured = (current?.state.providers ?? []).filter(provider => provider.configured);
		for (const provider of configured) {
			if (query && !`${provider.name} ${provider.id}`.toLowerCase().includes(query)) continue;
			const selected = provider.id === current?.selected;
			const row = action("", PROVIDER_SELECT_ACTION, provider.id, false, `connection-row${selected ? " selected" : ""}`);
			row.setAttribute("aria-pressed", String(selected));
			const top = document.createElement("span"); top.className = "connection-row-top";
			const dot = document.createElement("span");
			dot.className = "connection-status-dot configured";
			dot.setAttribute("aria-hidden", "true");
			top.append(node("span", provider.name, "connection-row-name"), dot);
			const meta = document.createElement("small"); meta.className = "connection-row-meta";
			const sep = node("span", " · ", "connection-row-sep"); sep.setAttribute("aria-hidden", "true");
			meta.append(
				node("span", copy("connections.configured"), "connection-row-state"),
				sep,
				node("span", String(provider.modelCount), "connection-row-count"),
			);
			row.append(top, meta);
			list.append(row);
		}
		if (!list.children.length) list.append(node("p", copy(configured.length === 0 ? "connections.empty" : "connections.noMatch"), "connection-empty"));
	};
	search.addEventListener("input", renderList);
	return { element: root, update(nextLocale: Locale, view: ModelConnectionsLike, extraNotices: readonly (PanelNotice & { readonly key?: string })[] = []) {
		locale = nextLocale; current = view;
		const canAdd = view.state.providers.some(provider => !provider.configured && (view.state.authentication.providers.find(item => item.id === provider.id)?.methods.length ?? 0) > 0);
		add.textContent = copy("connections.add"); add.disabled = view.disabled || !canAdd;
		search.placeholder = copy("connections.search"); search.setAttribute("aria-label", search.placeholder);

		notices.replaceChildren();
		if (view.state.error) {
			const alert = node("p", copy(view.state.error === "synchronization" ? "connections.syncError" : "connections.configError"), "panel-notice error");
			alert.setAttribute("role", "alert");
			notices.append(alert);
		}
		if (view.state.refresh.status === "warning") {
			const warn = node("p", copy("model.refreshWarning", { providers: Object.keys(view.state.refresh.errors ?? {}).join(", ") }), "panel-notice warning");
			warn.setAttribute("role", "status");
			notices.append(warn);
		}
		for (const notice of extraNotices) {
			const text = notice.tone === "error" ? errorMessageCopy(locale, notice.text) : notice.text;
			const item = node("p", text, `panel-notice ${notice.tone}`);
			if (notice.key !== undefined) item.dataset.noticeKey = notice.key;
			item.setAttribute("role", notice.tone === "error" ? "alert" : "status");
			notices.append(item);
		}
		notices.hidden = notices.children.length === 0;

		const defaults = view.state.defaults;
		const defaultRef = defaults ? JSON.stringify([defaults.model.provider, defaults.model.modelId]) : "";
		const options = [...view.enabledModels];
		if (defaults && !options.some(model => model.provider === defaults.model.provider && model.modelId === defaults.model.modelId))
			options.unshift({ ...defaults.model, name: `${defaults.model.provider}/${defaults.model.modelId}`, available: false });
		const defaultSelect = document.createElement("select");
		defaultSelect.className = "panel-select connection-default-select";
		defaultSelect.setAttribute("aria-label", copy("connections.defaultLabel"));
		defaultSelect.disabled = view.disabled || options.length === 0;
		if (defaultRef === "") {
			const placeholder = document.createElement("option");
			placeholder.value = "";
			placeholder.disabled = true;
			placeholder.selected = true;
			placeholder.textContent = copy(options.length === 0 ? "connections.noDefault" : "connections.chooseDefault");
			defaultSelect.append(placeholder);
		}
		const groups = new Map<string, HTMLOptGroupElement>();
		for (const model of options) {
			let group = groups.get(model.provider);
			if (!group) {
				group = document.createElement("optgroup");
				group.label = view.state.providers.find(provider => provider.id === model.provider)?.name ?? model.provider;
				groups.set(model.provider, group);
				defaultSelect.append(group);
			}
			const option = document.createElement("option");
			option.value = JSON.stringify([model.provider, model.modelId]);
			option.textContent = model.name;
			option.selected = option.value === defaultRef;
			group.append(option);
		}
		defaultSelect.addEventListener("change", () => {
			if (defaultSelect.value) report({ kind: "command", id: MODEL_DEFAULTS_ACTION, data: defaultSelect.value });
		});
		const refreshing = view.state.refresh.status === "refreshing";
		const refresh = action(copy("connections.refresh"), REFRESH_MODELS_ACTION, undefined, refreshing, "panel-button weight-line connection-default-refresh");
		if (refreshing) refresh.setAttribute("aria-busy", "true");
		const defaultControls = document.createElement("div");
		defaultControls.className = "connection-default-controls";
		defaultControls.append(defaultSelect, refresh);
		overview.replaceChildren(node("span", copy("connections.defaultLabel"), "connection-default-text"), defaultControls);

		renderList();
		detail.replaceChildren();
		const provider = view.state.providers.find(item => item.id === view.selected);
		if (!provider) {
			detail.append(node("p", copy("connections.choose"), "connection-empty connection-choose"));
			return;
		}

		const providerSection = document.createElement("section"); providerSection.className = "connection-provider";
		const providerHead = document.createElement("header"); providerHead.className = "connection-provider-head";
		const providerTitles = document.createElement("div"); providerTitles.className = "connection-provider-titles";
		const titleRow = document.createElement("div"); titleRow.className = "connection-provider-title-row";
		titleRow.append(
			node("h2", provider.name, "connection-provider-name"),
			node("span", copy(provider.configured ? "connections.configured" : "connections.unconfigured"), `panel-badge connection-badge ${provider.configured ? "configured" : "unconfigured"}`),
		);
		providerTitles.append(titleRow, node("p", provider.baseUrl, "connection-endpoint"));

		const controls = document.createElement("div"); controls.className = "connection-actions";
		const editable = EDITABLE_APIS.includes(provider.api);
		const auth = view.state.authentication.providers.find(item => item.id === provider.id);
		const canConfigure = editable || (auth?.methods.length ?? 0) > 0;
		controls.append(
			action(copy("connections.configure"), PROVIDER_EDIT_ACTION, provider.id, !canConfigure, !provider.configured && canConfigure ? "panel-button weight-filled" : "panel-button weight-line"),
			action(copy("connections.testAction"), PROVIDER_TEST_ACTION, provider.id, !provider.configured || view.loading || view.models.length === 0 || provider.verification.status === "checking"),
		);
		providerHead.append(providerTitles, controls);
		providerSection.append(providerHead);

		if (!canConfigure) providerSection.append(node("p", copy("connections.native"), "connection-native"));
		const verification = provider.verification;
		const status = node("p", verificationStatusText(locale, verification));
		status.className = `connection-verification ${verification.status}`; status.setAttribute("role", "status");
		providerSection.append(status);

		const modelsSection = document.createElement("section"); modelsSection.className = "connection-models-section";
		const modelsHead = document.createElement("header"); modelsHead.className = "connection-models-head";
		modelsHead.append(node("h3", copy("connections.models"), "connection-models-title"));
		const isEnabled = (model: ConnectionModelLike) => view.state.enabledModelIds === null || view.state.enabledModelIds.includes(`${model.provider}/${model.modelId}`);
		if (!view.loading && view.models.length > 0) {
			const enabledCount = view.models.filter(isEnabled).length;
			modelsHead.append(node("span", `${enabledCount} / ${view.models.length}`, "connection-models-count"));
		}
		modelsSection.append(modelsHead);

		detail.append(providerSection, modelsSection);
		if (view.loading) { modelsSection.append(node("p", copy("connection.connecting"), "connection-empty")); return; }
		if (!view.models.length) { modelsSection.append(node("p", copy("connections.discover"), "connection-empty")); return; }

		const modelList = document.createElement("div"); modelList.className = "connection-model-list";
		for (const model of view.models) {
			const modelRef = JSON.stringify([model.provider, model.modelId]);
			const row = document.createElement("div");
			row.className = `connection-model${!model.available ? " is-unavailable" : ""}`;
			const main = document.createElement("div"); main.className = "connection-model-main";
			const label = document.createElement("label"); label.className = "connection-model-label";
			const enabled = document.createElement("input"); enabled.type = "checkbox";
			enabled.checked = isEnabled(model);
			enabled.disabled = view.disabled;
			enabled.addEventListener("change", () => report({ kind: "control", id: MODEL_ENABLED_ACTION, data: modelRef, value: String(enabled.checked) }));
			label.append(enabled, node("span", model.name, "connection-model-name"));
			main.append(label, node("small", model.modelId, "connection-model-id"));
			row.append(main);
			modelList.append(row);
		}
		modelsSection.append(modelList);
	} };
}
