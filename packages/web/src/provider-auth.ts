/** Provider interaction is host-owned; this module only projects its public metadata. */
import type { AuthEvent, AuthInfoLink, AuthPrompt, AuthType } from "@amazme/ai";
import { PROVIDER_AUTH_ACTION, PROVIDER_AUTH_CANCEL_ACTION, PROVIDER_AUTH_MODAL, PROVIDER_AUTH_OPEN_ACTION } from "./actions.ts";
import type { Locale } from "./locale.ts";
import type { PanelButton, PanelField, PanelModal } from "./panels.ts";
import { translate } from "./strings.ts";

export interface ProviderAuthLike {
	readonly providers: readonly {
		readonly id: string;
		readonly name: string;
		readonly configured: boolean;
		readonly methods: readonly { readonly type: AuthType; readonly label: string }[];
	}[];
	readonly login: {
		readonly id: string;
		readonly provider: string;
		readonly status: "preparing" | "awaiting" | "finishing" | "done" | "cancelled" | "error";
		readonly authorization: Extract<AuthEvent, { type: "auth_url" | "device_code" }> | null;
		readonly message: string | null;
		readonly links: readonly AuthInfoLink[];
		readonly prompt: (AuthPrompt & { readonly id: string }) | null;
		readonly error: string | null;
	} | null;
}

export function providerAuthModal(locale: Locale, state: ProviderAuthLike, preferred?: string, mode: "login" | "logout" = "login"): PanelModal {
	const copy = (key: Parameters<typeof translate>[1]) => translate(locale, key);
	const providers = state.providers.filter(provider => mode === "logout" ? provider.configured : provider.methods.length > 0 || provider.configured);
	const fields: PanelField[] = [{
		id: "provider", label: copy("auth.provider"), kind: "select",
		value: providers.find(provider => provider.id === preferred)?.id ?? providers[0]?.id ?? "",
		options: providers.map(provider => ({ value: provider.id, label: `${provider.name}${provider.configured ? ` (${copy("auth.configured")})` : ""}` })),
	}];
	for (const provider of providers) fields.push({
		id: `method:${provider.id}`, label: copy("auth.method"), kind: "select",
		value: mode === "logout" && provider.configured ? "logout" : provider.methods[0]?.type ?? "logout",
		options: [
			...(mode === "login" ? provider.methods.map(method => ({ value: method.type, label: method.label })) : []),
			...(provider.configured ? [{ value: "logout", label: copy("auth.logout") }] : []),
		],
		visibleWhen: { field: "provider", values: [provider.id] },
	});
	return {
		id: PROVIDER_AUTH_MODAL, title: copy("auth.title"), description: copy("auth.help"), fields,
		submit: copy("auth.continue"), dismiss: copy("modal.close"),
	};
}

/** A fresh prompt id replaces the DOM input; submitted values never enter this view model. */
export function providerLoginModal(locale: Locale, state: ProviderAuthLike, login: ProviderAuthLike["login"]): PanelModal {
	const copy = (key: Parameters<typeof translate>[1]) => translate(locale, key);
	const active = login === null || ["preparing", "awaiting", "finishing"].includes(login.status);
	const prompt = active ? login?.prompt : null;
	const fields: PanelField[] = [];
	const actions: PanelButton[] = [];
	const authorization = active ? login?.authorization : null;
	if (authorization?.type === "device_code") fields.push({
		id: "code", label: copy("auth.deviceCode"), kind: "text", readOnly: true, value: authorization.userCode,
	});
	const links = active ? [
		...(authorization ? [{ url: authorization.type === "auth_url" ? authorization.url : authorization.verificationUri, label: copy("auth.open") }] : []),
		...(login?.links ?? []),
	] : [];
	for (const link of links) actions.push({ id: PROVIDER_AUTH_OPEN_ACTION, data: link.url, label: link.label ?? copy("auth.open"), tone: "default" });
	if (prompt) fields.push({
		id: "value", label: prompt.message, kind: prompt.type === "select" ? "select" : "text", value: "",
		...(prompt.type === "secret" ? { inputType: "password" as const } : {}),
		...(prompt.type === "select" ? { value: prompt.options[0]?.id ?? "", options: prompt.options.map(option => ({ value: option.id, label: option.label })) }
			: { placeholder: prompt.placeholder }),
	});
	if (active && login) actions.push({ id: PROVIDER_AUTH_CANCEL_ACTION, data: login.id, label: copy("auth.cancel"), tone: "danger" });
	if (!active) actions.push({ id: PROVIDER_AUTH_ACTION, label: copy("auth.title"), tone: "default" });
	const name = state.providers.find(provider => provider.id === login?.provider)?.name;
	const status = login?.status;
	const description = status === "done" ? copy("auth.done") : status === "cancelled" ? copy("auth.cancelled")
		: status === "error" ? undefined
		: prompt ? (authorization?.type === "auth_url" ? authorization.instructions : undefined)
		: login?.message ?? copy("auth.waiting");
	return {
		id: PROVIDER_AUTH_MODAL, data: JSON.stringify([login?.id ?? "", prompt?.id ?? ""]),
		title: name ?? copy("auth.title"), ...(description === undefined ? {} : { description }), fields, actions,
		...(prompt ? { submit: copy("auth.continue") } : {}), dismiss: copy("modal.close"),
		...(status === "error" ? { notice: { tone: "error" as const, text: login?.error ?? copy("auth.failed") } } : {}),
	};
}
