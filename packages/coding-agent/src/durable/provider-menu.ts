import type { Component, SelectItem, TUI } from "@amazme/tui";
import type { ProviderAuthManagement } from "../core/provider-login.ts";
import { LoginDialogComponent } from "../modes/interactive/components/login-dialog.ts";
import { openBrowser } from "../utils/open-browser.ts";

interface ProviderMenuPresentation {
	ui: TUI;
	mount(component: Component): void;
	select(title: string, items: SelectItem[], confirm: (value: string) => void, cancel: () => void): void;
	inform(text: string, close: () => void): void;
}

/** A native presentation of the provider interaction owner. */
export async function manageProviderAuth(
	auth: ProviderAuthManagement,
	mode: "login" | "logout",
	providerId: string | undefined,
	view: ProviderMenuPresentation,
	signal: AbortSignal,
): Promise<{ id: string } | { loggedOut: string } | undefined> {
	const choose = (title: string, items: SelectItem[]): Promise<string | undefined> => new Promise((resolve) => {
		const finish = (value?: string) => { signal.removeEventListener("abort", abort); resolve(value); };
		const abort = () => finish();
		if (signal.aborted) return finish();
		signal.addEventListener("abort", abort, { once: true });
		view.select(title, items, finish, abort);
	});
	const info = (text: string): Promise<void> => new Promise((resolve) => {
		const finish = () => { signal.removeEventListener("abort", finish); resolve(); };
		if (signal.aborted) return finish();
		signal.addEventListener("abort", finish, { once: true });
		view.inform(text, finish);
	});
	try {
		const snapshot = auth.snapshot();
		const existing = mode === "login" && snapshot.login && ["preparing", "awaiting", "finishing"].includes(snapshot.login.status)
			? snapshot.login : undefined;
		if (existing && providerId && existing.provider !== providerId) {
			await info("Finish or cancel the current sign-in. Use /login to open it."); return;
		}
		const providers = snapshot.providers;
		const candidates = providers.filter((entry) => mode === "login" ? entry.methods.length > 0 : entry.configured);
		const selected = existing?.provider ?? providerId ?? await choose(mode === "login" ? "Sign in to:" : "Remove saved credentials:",
			candidates.map((entry) => ({ value: entry.id, label: entry.name, description: entry.configured ? "configured" : "" })));
		if (selected === undefined || signal.aborted) return;
		const provider = providers.find((entry) => entry.id === selected);
		if (!provider) { await info("Unknown provider. Use /login to choose an available provider."); return; }
		if (mode === "logout") {
			await auth.logout(provider.id, signal);
			await info(`Removed saved credentials for ${provider.name}. Environment credentials remain available.`);
			return { loggedOut: provider.id };
		}
		const methodId = existing?.method ?? (provider.methods.length === 1 ? provider.methods[0]?.type : await choose(`Sign in to ${provider.name}:`,
			provider.methods.map((method) => ({ value: method.type, label: method.label }))));
		const method = provider.methods.find((entry) => entry.type === methodId)?.type;
		if (!method || signal.aborted) return;
		let id = existing?.id;
		let bound = false;
		let complete!: () => void;
		const finished = new Promise<void>((resolve) => { complete = resolve; });
		const cancel = () => { if (id) void auth.cancelLogin(id).then(complete, complete); };
		const dialog = new LoginDialogComponent(view.ui, provider.id, cancel, provider.name);
		view.mount(dialog);
		let authorization = "";
		let message = "";
		let promptId: string | null = null;
		const paintLogin = (): void => {
			if (id === undefined || signal.aborted) return;
			const login = auth.snapshot().login;
			if (!login || login.id !== id) {
				if (bound || signal.aborted) { dialog.clearPrompt(); complete(); }
				return;
			}
			bound = true;
			if (["done", "cancelled", "error"].includes(login.status)) { dialog.clearPrompt(); complete(); return; }
			const nextAuthorization = JSON.stringify(login.authorization);
			if (login.authorization && authorization !== nextAuthorization) {
				authorization = nextAuthorization;
				if (login.authorization.type === "auth_url") dialog.showAuth(login.authorization.url, login.authorization.instructions);
				else { dialog.showDeviceCode(login.authorization); openBrowser(login.authorization.verificationUri); }
			}
			const nextMessage = JSON.stringify([login.message, login.links]);
			if (login.message && message !== nextMessage) { message = nextMessage; dialog.showInfo(login.message, login.links); }
			if ((login.prompt?.id ?? null) === promptId) return;
			dialog.clearPrompt();
			promptId = login.prompt?.id ?? null;
			view.mount(dialog);
			const prompt = login.prompt;
			if (!prompt) return;
			const submit = (value: string) => {
				void auth.submitPrompt(login.id, prompt.id, value).catch(() => {
					const current = auth.snapshot().login;
					if (signal.aborted || current?.id !== login.id || current.prompt?.id !== prompt.id) return;
					dialog.showProgress("The input could not be accepted. Retry or cancel.");
					promptId = null;
					paintLogin();
				});
			};
			if (prompt.type === "select") {
				view.select(prompt.message, prompt.options.map((option) => ({
					value: option.id, label: option.label, description: option.description,
				})), submit, cancel);
			} else {
				const input = prompt.type === "manual_code" ? dialog.showManualInput(prompt.message)
					: dialog.showPrompt(prompt.message, prompt.placeholder, prompt.type === "secret");
				void input.then(submit, () => {});
			}
		};
		const stop = auth.subscribe(paintLogin);
		signal.addEventListener("abort", cancel, { once: true });
		try { id ??= await auth.startLogin(provider.id, method, signal); paintLogin(); await finished; return { id }; }
		finally { stop(); signal.removeEventListener("abort", cancel); dialog.clearPrompt(); }
	} catch {
		await info("Authentication could not complete. Check credentials from the CLI or retry.");
	}
}
