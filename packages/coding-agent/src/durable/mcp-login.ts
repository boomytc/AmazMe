import { randomUUID } from "node:crypto";
import type { Context } from "@amazme/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@amazme/chord/context";
import type { McpLoginState } from "../core/mcp/management.ts";
import type * as McpRuntime from "../extensions/mcp/runtime.ts";
import type { McpServerConnection } from "../extensions/mcp/runtime.ts";
import { publicMcpError as publicError } from "../core/mcp/errors.ts";

/** The session owns one browser flow; its callback, timeout and redirect waiter close together. */
export class McpLogin {
	readonly #options: McpLoginOptions;
	#login:
		| {
				state: McpLoginState;
				controller: AbortController;
				done: Promise<void>;
				redirect?: (value: string | undefined) => void;
		  }
		| undefined;
	constructor(options: McpLoginOptions) {
		this.#options = options;
	}
	snapshot(): McpLoginState | null {
		return this.#login ? { ...this.#login.state } : null;
	}
	cancelServer(name: string): void {
		if (this.#login?.state.server === name) this.#login.controller.abort();
	}
	async startLogin(name: string, context: Context): Promise<string> {
		this.#options.signal.throwIfAborted();
		context.abortSignal?.throwIfAborted();
		if (this.#login && ["preparing", "awaiting", "finishing"].includes(this.#login.state.status))
			throw new Error("Finish or cancel the current MCP sign-in first");
		const connection = this.#options.connection(name);
		if (!connection?.oauthUrl) throw new Error(`MCP server ${name} does not use browser sign-in`);
		const controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, this.#options.signal, AbortSignal.timeout(300_000)]);
		let ready!: () => void;
		const shown = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const state: McpLoginState = { id: randomUUID(), server: name, status: "preparing", url: null, error: null };
		const operation = {
			state,
			controller,
			done: Promise.resolve(),
			redirect: undefined as ((value: string | undefined) => void) | undefined,
		};
		this.#login = operation;
		this.#options.publish();
		operation.done = this.#options.runtime
			.signInMcpServer({
				serverUrl: connection.oauthUrl,
				store: this.#options.credentials.forServer(name, connection.oauthUrl),
				settings: connection.oauthSettings(),
				challenge: connection.challenge,
				signal,
				prompt: {
					showAuthorizationUrl: (url) => {
						state.url = url.href;
						state.status = "awaiting";
						this.#options.publish();
						ready();
					},
					promptForRedirectUrl: (callbackSignal) =>
						new Promise((resolve) => {
							const finish = (value: string | undefined) => {
								callbackSignal.removeEventListener("abort", onAbort);
								operation.redirect = undefined;
								resolve(value);
							};
							const onAbort = () => finish(undefined);
							operation.redirect = finish;
							if (callbackSignal.aborted) finish(undefined);
							else callbackSignal.addEventListener("abort", onAbort, { once: true });
						}),
				},
			})
			.then(async () => {
				connection.challenge = undefined;
				await this.#options.reconnect(name, withAbortSignal(signal, BACKGROUND_CONTEXT));
				state.status = "done";
			})
			.catch((error) => {
				state.status = signal.aborted ? "cancelled" : "error";
				state.error = signal.aborted ? null : publicError(error);
			})
			.finally(() => {
				state.url = null;
				ready();
				this.#options.publish();
			});
		try {
			await awaitWithContext(Promise.race([shown, operation.done]), context);
		} catch (error) {
			controller.abort();
			await operation.done;
			throw error;
		}
		return state.id;
	}

	async submitRedirect(id: string, url: string, context: Context): Promise<boolean> {
		this.#options.signal.throwIfAborted();
		context.abortSignal?.throwIfAborted();
		const login = this.#login;
		if (!login || login.state.id !== id || !login.redirect) return false;
		login.state.status = "finishing";
		login.redirect(url);
		this.#options.publish();
		return true;
	}
	async cancelLogin(id: string): Promise<boolean> {
		const login = this.#login;
		if (!login || login.state.id !== id) return false;
		login.controller.abort();
		await login.done;
		return true;
	}

	async close(): Promise<void> {
		this.#login?.controller.abort();
		await this.#login?.done;
	}
}

export interface McpLoginOptions {
	runtime: typeof McpRuntime;
	credentials: McpRuntime.McpOAuthCredentialStore;
	signal: AbortSignal;
	connection(name: string): McpServerConnection | undefined;
	reconnect(name: string, context: Context): Promise<void>;
	publish(): void;
}
