import type { Locale } from "./locale.ts";
import type { PanelAction, PanelModal } from "./panels.ts";
import type { ProviderAuthLike } from "./provider-auth.ts";
import { MODEL_DEFAULTS_ACTION, PROVIDER_AUTH_ACTION, REFRESH_MODELS_ACTION } from "./actions.ts";
import { translate } from "./strings.ts";

export const MODEL_CONNECTIONS_ACTION = "models:connections";
export const PROVIDER_SELECT_ACTION = "models:provider";
export const PROVIDER_EDIT_ACTION = "models:edit-provider";
export const PROVIDER_EDIT_MODAL = "models:save-provider";
export const PROVIDER_TEST_ACTION = "models:test";
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
	readonly loading: boolean;
	readonly disabled: boolean;
}

export function providerConfigurationModal(locale: Locale, provider?: ModelConnectionsLike["state"]["providers"][number], models: readonly ConnectionModelLike[] = []): PanelModal {
	const copy = (key: Parameters<typeof translate>[1]) => translate(locale, key);
	return { id: PROVIDER_EDIT_MODAL, data: provider?.id, title: copy(provider ? "connections.edit" : "connections.add"), submit: copy("modal.save"), fields: [
		{ id: "id", label: copy("connections.id"), kind: "text", value: provider?.id ?? "", ...(provider ? { readOnly: true } : {}) },
		{ id: "name", label: copy("connections.name"), kind: "text", value: provider?.name ?? "" },
		{ id: "baseUrl", label: copy("connections.endpoint"), kind: "text", value: provider?.baseUrl ?? "" },
		{ id: "api", label: copy("connections.protocol"), kind: "select", value: provider?.api ?? "openai-completions", options: [
			{ value: "openai-completions", label: "OpenAI Chat Completions" }, { value: "openai-responses", label: "OpenAI Responses" },
			{ value: "anthropic-messages", label: "Anthropic Messages" }, { value: "google-generative-ai", label: "Google Generative AI" },
		] },
		...(!provider || provider.custom ? [{ id: "models", label: copy("connections.modelIds"), kind: "textarea" as const, value: (provider?.modelIds ?? models.map(model => model.modelId)).join("\n") }] : []),
	] };
}

/** The provider search stays mounted while connection and model states change. */
export function createModelConnections(report: (action: PanelAction) => void) {
	const root = document.createElement("section"); root.className = "model-connections";
	const rail = document.createElement("aside"); rail.className = "connection-rail";
	const search = document.createElement("input"); search.type = "search";
	const list = document.createElement("div"); list.className = "connection-list";
	const detail = document.createElement("div"); detail.className = "connection-detail";
	const title = document.createElement("h2");
	const add = document.createElement("button"); add.type = "button";
	add.addEventListener("click", () => report({ kind: "command", id: PROVIDER_EDIT_ACTION, data: undefined }));
	rail.append(title, add, search, list); root.append(rail, detail);
	let current: ModelConnectionsLike | undefined;
	let locale: Locale = "en";
	const copy = (key: Parameters<typeof translate>[1], values?: Record<string, string>) => translate(locale, key, values);
	const node = (tag: string, text: string) => { const result = document.createElement(tag); result.textContent = text; return result; };
	const action = (label: string, id: string, data?: string, disabled = false) => {
		const control = document.createElement("button"); control.type = "button"; control.textContent = label;
		control.disabled = current?.disabled === true || disabled;
		control.addEventListener("click", () => report({ kind: "command", id, data })); return control;
	};
	const renderList = () => {
		list.replaceChildren();
		const query = search.value.trim().toLowerCase();
		for (const provider of current?.state.providers ?? []) {
			if (!`${provider.name} ${provider.id}`.toLowerCase().includes(query)) continue;
			const row = action(provider.name, PROVIDER_SELECT_ACTION, provider.id);
			row.className = `connection-row${provider.id === current?.selected ? " selected" : ""}`;
			row.setAttribute("aria-pressed", String(provider.id === current?.selected));
			row.append(node("small", `${copy(provider.configured ? "connections.configured" : "connections.unconfigured")} · ${provider.modelCount}`));
			list.append(row);
		}
		if (!list.children.length) list.append(node("p", copy("project.noMatch")));
	};
	search.addEventListener("input", renderList);
	return { element: root, update(nextLocale: Locale, view: ModelConnectionsLike) {
		locale = nextLocale; current = view;
		title.textContent = copy("connections.title"); add.textContent = copy("connections.add"); add.disabled = view.disabled;
		search.placeholder = copy("connections.search"); search.setAttribute("aria-label", search.placeholder);
		renderList(); detail.replaceChildren();
		const provider = view.state.providers.find(provider => provider.id === view.selected);
		const defaults = view.state.defaults;
		detail.append(node("p", defaults ? copy("connections.default", { model: `${defaults.model.provider}/${defaults.model.modelId}` }) : copy("connections.noDefault")));
		const refreshing = view.state.refresh.status === "refreshing";
		detail.append(action(copy("model.defaults"), MODEL_DEFAULTS_ACTION), action(copy(refreshing ? "model.refreshing" : "model.refresh"), REFRESH_MODELS_ACTION, undefined, refreshing));
		if (view.state.refresh.status === "warning") detail.append(node("p", copy("model.refreshWarning", { providers: Object.keys(view.state.refresh.errors ?? {}).join(", ") })));
		detail.append(action(copy("connections.back"), "models:back"));
		if (view.state.error) detail.append(node("p", copy(view.state.error === "synchronization" ? "connections.syncError" : "connections.configError")));
		if (!provider) { detail.append(node("p", copy("connections.choose"))); return; }
		detail.append(node("h2", provider.name), node("p", copy(provider.configured ? "connections.configured" : "connections.unconfigured")), node("p", provider.baseUrl));
		const controls = document.createElement("div"); controls.className = "connection-actions";
		const editable = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].includes(provider.api);
		const auth = view.state.authentication.providers.find(item => item.id === provider.id);
		const canAuthenticate = (auth?.methods.length ?? 0) > 0 || provider.configured;
		controls.append(action(copy("connections.edit"), PROVIDER_EDIT_ACTION, provider.id, !editable), action(copy(provider.configured ? "auth.title" : "model.connectProvider"), PROVIDER_AUTH_ACTION, provider.id, !canAuthenticate));
		detail.append(controls);
		if (!editable || !canAuthenticate) detail.append(node("p", copy("connections.native")));
		const verification = provider.verification;
		const status = node("p", copy(verification.status === "success" ? "connections.verified" : verification.status === "error" ? "connections.failed" : verification.status === "checking" ? "connections.testing" : "connections.untested"));
		status.className = `connection-verification ${verification.status}`; status.setAttribute("role", "status");
		if (verification.modelId) status.prepend(document.createTextNode(`${verification.modelId} · `));
		if (verification.checkedAt) status.append(document.createTextNode(` · ${new Date(verification.checkedAt).toLocaleString(locale)}`));
		detail.append(status, node("h3", copy("connections.models")));
		if (view.loading) { detail.append(node("p", copy("connection.connecting"))); return; }
		if (!view.models.length) detail.append(node("p", copy("connections.discover")));
		for (const model of view.models) {
			const row = document.createElement("div"); row.className = "connection-model";
			const label = document.createElement("label"); const enabled = document.createElement("input"); enabled.type = "checkbox";
			enabled.checked = view.state.enabledModelIds === null || view.state.enabledModelIds.includes(`${model.provider}/${model.modelId}`);
			enabled.disabled = view.disabled;
			enabled.addEventListener("change", () => report({ kind: "control", id: MODEL_ENABLED_ACTION, data: JSON.stringify([model.provider, model.modelId]), value: String(enabled.checked) }));
			label.append(enabled, document.createTextNode(model.name));
			row.append(label, node("small", model.modelId), action(copy("model.defaults"), MODEL_DEFAULTS_ACTION, JSON.stringify([model.provider, model.modelId]), !model.available), action(copy("connections.test"), PROVIDER_TEST_ACTION, JSON.stringify([model.provider, model.modelId]), !model.available || verification.status === "checking"));
			detail.append(row);
		}
	} };
}
