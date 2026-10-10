import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthInfoLink, AuthPrompt, AuthType, LoginOptions } from "@amazme/ai";
import { CredentialSynchronizationError } from "./model-runtime.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";

type WithoutSignal<T> = T extends { options: readonly (infer Option)[] }
	? Omit<T, "signal" | "options"> & { options: Option[] }
	: T extends AuthPrompt ? Omit<T, "signal"> : never;
export type ProviderLoginPrompt = WithoutSignal<AuthPrompt> & { id: string };
export interface ProviderAuthSummary {
	id: string;
	name: string;
	configured: boolean;
	methods: { type: AuthType; label: string }[];
}
export interface ProviderLoginState {
	id: string;
	provider: string;
	method: AuthType;
	status: "preparing" | "awaiting" | "finishing" | "done" | "cancelled" | "error";
	authorization: Extract<AuthEvent, { type: "auth_url" | "device_code" }> | null;
	message: string | null;
	links: AuthInfoLink[];
	prompt: ProviderLoginPrompt | null;
	error: string | null;
}
export interface ProviderAuthState {
	providers: ProviderAuthSummary[];
	login: ProviderLoginState | null;
}
export interface ProviderAuthManagement {
	snapshot(): ProviderAuthState;
	subscribe(listener: () => void): () => void;
	startLogin(provider: string, method: AuthType, signal?: AbortSignal): Promise<string>;
	submitPrompt(id: string, promptId: string, value: string): Promise<boolean>;
	cancelLogin(id: string): Promise<boolean>;
	logout(provider: string, signal?: AbortSignal): Promise<void>;
}
interface LoginOperation {
	state: ProviderLoginState;
	controller: AbortController;
	done: Promise<void>;
	submit?: { id: string; resolve(value: string): void };
}

/** Owns one transient interaction; the ModelRuntime owns provider protocols and credential writes. */
export class ProviderLogin implements ProviderAuthManagement {
	readonly #owner = new AbortController();
	readonly #listeners = new Set<() => void>();
	#operation: LoginOperation | undefined;
	#logout: Promise<void> | undefined;

	readonly #runtime: ModelRuntime;
	readonly #options: LoginOptions;
	constructor(runtime: ModelRuntime, options: LoginOptions = {}) {
		this.#runtime = runtime;
		this.#options = options;
	}

	snapshot(): ProviderAuthState {
		return {
			providers: this.#runtime.getProviders().map((provider) => ({
				id: provider.id, name: provider.name, configured: this.#runtime.getProviderAuthStatus(provider.id).configured,
				methods: [
					...(provider.auth.oauth ? [{ type: "oauth" as const, label: provider.auth.oauth.name }] : []),
					...(provider.auth.apiKey?.login ? [{ type: "api_key" as const, label: provider.auth.apiKey.name }] : []),
				],
			})),
			// Provider prompts may include optional undefined fields; the public replica is JSON.
			login: this.#operation ? JSON.parse(JSON.stringify(this.#operation.state)) as ProviderLoginState : null,
		};
	}
	get active(): boolean {
		return this.#logout !== undefined || (this.#operation !== undefined && ["preparing", "awaiting", "finishing"].includes(this.#operation.state.status));
	}
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#publish(): void {
		for (const listener of this.#listeners) listener();
	}
	async startLogin(provider: string, method: AuthType, signal?: AbortSignal): Promise<string> {
		this.#owner.signal.throwIfAborted();
		signal?.throwIfAborted();
		if (this.active) throw new Error("Finish or cancel the current provider sign-in first");
		if (!this.snapshot().providers.find((entry) => entry.id === provider)?.methods.some((entry) => entry.type === method))
			throw new Error("The provider does not support this login method");
		const controller = new AbortController();
		const loginSignal = AbortSignal.any([this.#owner.signal, controller.signal, AbortSignal.timeout(300_000)]);
		let ready!: () => void;
		const shown = new Promise<void>((resolve) => { ready = resolve; });
		const state: ProviderLoginState = {
			id: randomUUID(), provider, method, status: "preparing", authorization: null,
			message: null, links: [], prompt: null, error: null,
		};
		const operation: LoginOperation = { state, controller, done: Promise.resolve() };
		this.#operation = operation;
		this.#publish();
		operation.done = this.#runtime.login(provider, method, {
			signal: loginSignal,
			notify: (event) => {
				if (loginSignal.aborted) return;
				if (event.type === "auth_url" || event.type === "device_code") state.authorization = event;
				else {
					state.message = event.message;
					if (event.type === "info") state.links = [...event.links ?? []];
				}
				state.status = "awaiting";
				this.#publish(); ready();
			},
			prompt: (prompt) => new Promise<string>((resolve, reject) => {
				const promptSignal = prompt.signal ? AbortSignal.any([loginSignal, prompt.signal]) : loginSignal;
				const { signal: _signal, ...publicPrompt } = prompt;
				const id = randomUUID();
				const finish = (value?: string) => {
					promptSignal.removeEventListener("abort", abort);
					if (operation.submit?.id === id) operation.submit = undefined;
					if (state.prompt?.id === id) state.prompt = null;
					state.status = "finishing";
					this.#publish();
					if (value === undefined) reject(new Error("Login prompt cancelled"));
					else resolve(value);
				};
				const abort = () => finish();
				operation.submit = { id, resolve: (value) => finish(value) };
				state.prompt = publicPrompt.type === "select"
					? { ...publicPrompt, options: publicPrompt.options.map((option) => ({ ...option })), id }
					: { ...publicPrompt, id };
				state.status = "awaiting";
				if (promptSignal.aborted) finish();
				else promptSignal.addEventListener("abort", abort, { once: true });
				this.#publish(); ready();
			}),
		}, this.#options).then(() => { state.status = "done"; }).catch((error: unknown) => {
			state.status = loginSignal.aborted ? "cancelled" : "error";
			state.error = error instanceof CredentialSynchronizationError
				? "Credentials saved, but local model state could not be synchronized. Refresh the model catalog."
				: loginSignal.aborted ? null : "Provider sign-in failed. Retry or check authentication from the CLI.";
		}).finally(() => {
			state.authorization = null; state.prompt = null; state.message = null; state.links = [];
			this.#publish(); ready();
		});
		try { await raceWithAbortSignal(Promise.race([shown, operation.done]), signal); }
		catch (error) { controller.abort(); await operation.done; throw error; }
		return state.id;
	}
	async submitPrompt(id: string, promptId: string, value: string): Promise<boolean> {
		this.#owner.signal.throwIfAborted();
		const operation = this.#operation;
		const prompt = operation?.state.prompt;
		if (!operation || operation.state.id !== id || !prompt || prompt.id !== promptId || operation.submit?.id !== promptId)
			return false;
		if (prompt.type === "select" && !prompt.options.some((option) => option.id === value))
			throw new Error("Choose one of the available options");
		if (prompt.type === "secret" && !value.trim()) throw new Error("A credential is required");
		operation.submit.resolve(value);
		return true;
	}
	async cancelLogin(id: string): Promise<boolean> {
		const operation = this.#operation;
		if (!operation || operation.state.id !== id) return false;
		operation.controller.abort(); await operation.done;
		return true;
	}
	async logout(provider: string, signal?: AbortSignal): Promise<void> {
		this.#owner.signal.throwIfAborted();
		signal?.throwIfAborted();
		if (this.active) throw new Error("Finish or cancel the current provider sign-in first");
		const done = this.#runtime.logout(provider, { signal: AbortSignal.any([this.#owner.signal, ...(signal ? [signal] : [])]) });
		this.#logout = done;
		try { await done; }
		finally { this.#logout = undefined; this.#publish(); }
	}
	async close(): Promise<void> {
		this.#owner.abort();
		await this.#operation?.done;
		await this.#logout?.catch(() => {});
		this.#listeners.clear();
	}
}
