import type { Locale } from "./locale.ts";
import type { PanelModal } from "./panels.ts";
import type { ProviderAuthLike } from "./provider-auth.ts";
import { translate } from "./strings.ts";

export const PROVIDER_SELECT_ACTION = "models:provider";
export const PROVIDER_LOGOUT_ACTION = "models:logout";
export const PROVIDER_LOGOUT_MODAL = "models:logout-confirm";
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
			readonly id: string; readonly name: string; readonly configured: boolean; readonly available: boolean;
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
	return { id: PROVIDER_EDIT_MODAL, data: provider.id, title: copy("connections.configure"), submit: copy(onlyLogin ? "auth.continue" : "modal.save"),
		...(provider.configured ? { actions: [{ id: PROVIDER_LOGOUT_ACTION, data: provider.id, label: copy("connections.delete"), weight: "line" as const, danger: true, placement: "start" as const }] } : {}),
		fields: [
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

export function providerLogoutModal(locale: Locale, providerId: string, name: string): PanelModal {
	return {
		id: PROVIDER_LOGOUT_MODAL, data: providerId, title: translate(locale, "connections.logout"),
		description: translate(locale, "connections.logoutHelp", { name }),
		fields: [], submit: translate(locale, "connections.logoutSubmit"), danger: true,
	};
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
