import type {
	AccountsView,
	ConfigureProvider,
	CredentialUpdate,
	Identity,
	ModelCatalog,
	OAuthView,
	ProviderCheck,
} from "../generated/contracts.ts";
import type { ModelConnectionsLike } from "../model-connections.ts";
import {
	PROVIDER_TEST_MODAL,
	verificationStatusText,
} from "../model-connections.ts";
import type { ProviderAuthLike } from "../provider-auth.ts";
import { providerLoginModal } from "../provider-auth.ts";
import type { PanelModal } from "../panels.ts";
import { parseContract } from "../transport/api.ts";
import { newId } from "./pending/writes.ts";
import type { PageServices } from "./services.ts";

interface ProviderServices extends PageServices {
	readonly refresh: () => Promise<void>;
	readonly ready: () => boolean;
	readonly globalModels: () => string[] | null;
}

interface OAuthOperation {
	readonly identity: Identity;
	readonly provider: string;
	readonly loginId: string;
	readonly generation: number;
	modal?: PanelModal;
	view?: OAuthView;
	timer?: ReturnType<typeof setTimeout>;
}

export const OAUTH_METHODS: Readonly<
	Record<string, "browser" | "device_code">
> = {
	anthropic: "browser",
	openai: "browser",
	"openai-codex": "browser",
	openrouter: "browser",
	"github-copilot": "device_code",
	"kimi-coding": "device_code",
	xai: "device_code",
	meta: "device_code",
};

export class Providers {
	catalog?: ModelCatalog;
	accounts: AccountsView = { revision: 0, accounts: [] };
	readonly providerVerification = new Map<string, ProviderCheck>();
	readonly checkingProviders = new Set<string>();
	selectedProvider?: string;
	providerEdit?: {
		readonly generation: number;
		readonly revision: number;
		readonly configurationRevision: number;
		configuration?: ConfigureProvider;
		credentialRevision?: number;
		credential?: CredentialUpdate;
	};
	private readonly oauthOperations = new Map<string, OAuthOperation>();
	private displayedOAuth?: OAuthOperation;
	private readonly services: ProviderServices;
	constructor(services: ProviderServices) {
		this.services = services;
	}
	dispose(): void {
		for (const operation of this.oauthOperations.values())
			clearTimeout(operation.timer);
		this.oauthOperations.clear();
		this.displayedOAuth = undefined;
	}
	get modalOAuth(): OAuthView | undefined {
		const operation = this.displayedOAuth;
		return operation && this.oauthVisible(operation)
			? operation.view
			: undefined;
	}
	authentication(login = this.modalOAuth): ProviderAuthLike {
		const ids = [
			...new Set([
				...(this.catalog?.models.map((item) => item.provider) ?? []),
				...Object.keys(OAUTH_METHODS),
			]),
		];
		const current = this.catalog?.current;
		const providers: ProviderAuthLike["providers"] = ids.map((id) => ({
			id,
			name:
				this.catalog?.providers?.find((item) => item.provider === id)?.name ||
				id,
			configured:
				this.accounts.accounts.some((item) => item.provider === id) ||
				(current?.provider === id && (id === "faux" || current.key_configured)),
			methods: [
				{ type: "api_key", label: "API Key" },
				...(OAUTH_METHODS[id]
					? [{ type: "oauth" as const, label: "登录" }]
					: []),
			],
		}));
		return {
			providers,
			login: login
				? {
						id: login.login_id,
						provider: login.provider,
						status:
							login.phase === "pending"
								? "awaiting"
								: login.phase === "complete"
									? "done"
									: login.phase === "cancelled"
										? "cancelled"
										: "error",
						authorization: login.url
							? login.user_code
								? {
										type: "device_code",
										userCode: login.user_code,
										verificationUri: login.url,
									}
								: { type: "auth_url", url: login.url }
							: null,
						message: null,
						links: [],
						prompt:
							login.phase === "pending" && !login.user_code
								? {
										id: login.login_id,
										type: "secret",
										message: "回调地址或授权码",
									}
								: null,
						error: login.error ?? null,
					}
				: null,
		};
	}
	connections(): ModelConnectionsLike {
		const authentication = this.authentication(),
			current = this.catalog?.current;
		const availableProviders = new Set(
			authentication.providers
				.filter(
					(provider) =>
						provider.configured &&
						!this.accounts.accounts.some(
							(account) =>
								account.provider === provider.id && account.login_required,
						),
				)
				.map((provider) => provider.id),
		);
		const models =
			this.catalog?.models.map((item) => ({
				provider: item.provider,
				modelId: item.model,
				name: item.label,
				available: availableProviders.has(item.provider),
			})) ?? [];
		const selected = authentication.providers.some(
			(provider) =>
				provider.id === this.selectedProvider && provider.configured,
		)
			? this.selectedProvider
			: authentication.providers.find((provider) => provider.configured)?.id;
		const enabled = this.services.globalModels();
		return {
			state: {
				providers: authentication.providers.map((provider) => {
					const model = this.catalog?.models.find(
							(item) => item.provider === provider.id,
						),
						definition = this.catalog?.providers?.find(
							(item) => item.provider === provider.id,
						);
					return {
						id: provider.id,
						name: provider.name,
						configured: provider.configured,
						available: availableProviders.has(provider.id),
						baseUrl:
							definition?.base_url ??
							(current?.provider === provider.id
								? current.base_url
								: (model?.base_url ?? "")),
						api:
							definition?.api ??
							(current?.provider === provider.id
								? (current.api ?? "openai-completions")
								: (model?.api ?? "openai-completions")),
						modelCount: models.filter((item) => item.provider === provider.id)
							.length,
						custom: definition?.model_ids != null,
						modelIds: definition?.model_ids ?? undefined,
						verification: this.verification(provider.id),
					};
				}),
				authentication,
				enabledModelIds: enabled,
				defaults: current
					? {
							model: { provider: current.provider, modelId: current.model },
							thinkingLevel: current.thinking ?? "off",
						}
					: null,
				error: null,
				refresh: { status: "idle" },
			},
			selected,
			models: models.filter((item) => item.provider === selected),
			enabledModels: models.filter(
				(item) =>
					item.available &&
					(enabled === null ||
						enabled.includes(`${item.provider}/${item.modelId}`)),
			),
			loading: false,
			disabled: !this.services.ready(),
		};
	}
	private verification(
		provider: string,
	): ModelConnectionsLike["state"]["providers"][number]["verification"] {
		if (this.checkingProviders.has(provider)) return { status: "checking" };
		const result = this.providerVerification.get(provider);
		if (
			!result ||
			result.configuration_revision !==
				(this.catalog?.configuration_revision ?? 0) ||
			result.credential_revision !== this.accounts.revision
		)
			return { status: "idle" };
		return {
			status:
				result.phase === "done" && !result.failed?.length ? "success" : "error",
			checkedAt: result.checked_at || undefined,
		};
	}
	async checkProvider(
		provider: string | undefined,
		model: string | undefined,
	): Promise<void> {
		const identity = this.services.client.identity,
			modal = this.services.panels.modal;
		if (
			!identity ||
			!provider ||
			modal?.id !== PROVIDER_TEST_MODAL ||
			modal.data !== provider ||
			this.services.panels.modalPending ||
			this.checkingProviders.has(provider)
		)
			return;
		const key = `amazme:provider-check:${identity.profile_id}:${provider}`,
			stored = sessionStorage.getItem(key);
		const body = parseContract(
			"ProviderCheckRequest",
			stored
				? JSON.parse(stored)
				: {
						operation_id: newId(),
						provider,
						model_ids:
							model === undefined
								? (this.catalog?.models
										.filter((item) => item.provider === provider)
										.map((item) => item.model) ?? [])
								: [model],
					},
		);
		if (body.provider !== provider) throw new Error("原检查不属于此供应商");
		const serialized = JSON.stringify(body);
		sessionStorage.setItem(key, serialized);
		this.checkingProviders.add(provider);
		this.services.panels.pendingModal = modal;
		this.services.changed();
		try {
			const result = await this.services.client.call(
				"POST /api/v1/providers/{provider}/check",
				{ path: { provider }, body, identity },
			);
			if (
				result.operation_id !== body.operation_id ||
				result.provider !== provider
			)
				throw new Error("检查回执编号不匹配；原编号已保留");
			if (result.phase === "done" && sessionStorage.getItem(key) === serialized)
				sessionStorage.removeItem(key);
			if (!this.services.hostActive(identity)) return;
			this.providerVerification.set(provider, result);
			if (this.services.panels.modal === modal) {
				const current =
					result.configuration_revision ===
						(this.catalog?.configuration_revision ?? 0) &&
					result.credential_revision === this.accounts.revision;
				this.services.panels.modal = {
					...modal,
					notice: {
						tone:
							result.phase === "done" && !result.failed?.length && current
								? "info"
								: "error",
						text: !current
							? "供应商配置已变化；这是原配置的检查结果。"
							: result.phase !== "done"
								? "原检查尚未确认；再次提交仅核对原编号，不会重新请求模型。"
								: verificationStatusText(
										this.services.locale(),
										{
											status: result.failed?.length ? "error" : "success",
											checkedAt: result.checked_at || undefined,
										},
										result.failed?.join(", "),
									),
					},
				};
			}
		} finally {
			this.checkingProviders.delete(provider);
			if (this.services.panels.pendingModal === modal)
				this.services.panels.pendingModal = undefined;
			if (this.services.hostActive(identity)) this.services.changed();
		}
	}
	async saveProvider(
		data: string | undefined,
		fields: Readonly<Record<string, string>>,
		clear: boolean,
	): Promise<void> {
		if (this.services.panels.modalPending) return;
		const identity = this.services.client.identity,
			provider = data ?? fields.id,
			modal = this.services.panels.modal,
			generation = this.services.panels.generation;
		if (!identity || !modal || !provider)
			throw new Error("请选择供应商并连接后端");
		if (!this.services.hostActive(identity)) return;
		const oauthKey = `amazme:oauth:${identity.profile_id}:${provider}`;
		const oauth = !clear && fields[`method:${provider}`] === "oauth";
		if (oauth && !OAUTH_METHODS[provider])
			throw new Error("供应商不支持此登录方式");
		const storedOAuth = oauth ? sessionStorage.getItem(oauthKey) : null;
		const savedOAuth = storedOAuth
			? parseContract("OAuthStart", JSON.parse(storedOAuth))
			: undefined;
		if (savedOAuth && savedOAuth.provider !== provider)
			throw new Error("授权归属不匹配，原记录已保留");
		const oauthOperation = oauth
			? this.beginOAuth(
					identity,
					provider,
					savedOAuth?.login_id ?? newId(),
					generation,
				)
			: undefined;
		const owner =
			this.providerEdit?.generation === generation
				? this.providerEdit
				: {
						generation,
						revision: this.accounts.revision,
						configurationRevision: this.catalog?.configuration_revision ?? 0,
					};
		this.providerEdit = owner;
		const current = () =>
			this.services.hostActive(identity) &&
			generation === this.services.panels.generation;
		this.services.panels.pendingModal = modal;
		this.services.changed();
		try {
			if (clear)
				await this.services.client.call("POST /api/v1/accounts/{provider}", {
					path: { provider },
					body: { expected_revision: owner.revision, clear: true },
					identity,
				});
			else {
				if (fields.baseUrl !== undefined) {
					const storageKey = `amazme:provider:${identity.profile_id}:${provider}`;
					const saved = sessionStorage.getItem(storageKey);
					owner.configuration ??= saved
						? parseContract("ConfigureProvider", JSON.parse(saved))
						: parseContract("ConfigureProvider", {
								operation_id: newId(),
								expected_revision: owner.configurationRevision,
								provider,
								name: fields.name || provider,
								base_url: fields.baseUrl,
								api: fields.api,
								...(fields.models === undefined
									? {}
									: {
											model_ids: fields.models
												.split("\n")
												.map((item) => item.trim())
												.filter(Boolean),
										}),
							});
					if (owner.configuration.provider !== provider)
						throw new Error("配置归属不匹配，原记录已保留");
					sessionStorage.setItem(
						storageKey,
						JSON.stringify(owner.configuration),
					);
					const result = await this.services.client.call(
						"PUT /api/v1/providers/{provider}",
						{ path: { provider }, body: owner.configuration, identity },
					);
					if (
						result.operation_id !== owner.configuration.operation_id ||
						result.provider !== provider
					)
						throw new Error("配置回执归属不匹配，原记录已保留");
					owner.credentialRevision = result.credential_revision;
					const stored = sessionStorage.getItem(storageKey);
					if (
						stored &&
						parseContract("ConfigureProvider", JSON.parse(stored))
							.operation_id === owner.configuration.operation_id
					)
						sessionStorage.removeItem(storageKey);
					if (this.services.hostActive(identity)) await this.services.refresh();
				}
				if (!this.services.hostActive(identity)) return;
				const revision = owner.credentialRevision ?? owner.revision;
				if (oauthOperation) {
					if (!this.oauthActive(oauthOperation)) return;
					const request = savedOAuth ?? {
						login_id: oauthOperation.loginId,
						provider,
						expected_revision: revision,
						method: OAUTH_METHODS[provider],
					};
					sessionStorage.setItem(oauthKey, JSON.stringify(request));
					const login = await this.services.client.call(
						"POST /api/v1/accounts/oauth",
						{ body: request, identity },
					);
					this.observeOAuth(oauthOperation, login);
					return;
				}
				const key = fields[`key:${provider}`] ?? "";
				if (key || owner.credential) {
					owner.credential ??= { expected_revision: revision, api_key: key };
					await this.services.client.call("POST /api/v1/accounts/{provider}", {
						path: { provider },
						body: owner.credential,
						identity,
					});
				} else if (
					!this.accounts.accounts.some((item) => item.provider === provider) &&
					!(
						this.catalog?.current.provider === provider &&
						this.catalog.current.key_configured
					)
				)
					throw new Error("请输入密钥或选择登录方式");
			}
			if (this.services.hostActive(identity)) await this.services.refresh();
			if (current()) {
				this.services.panels.modal = undefined;
				this.services.changed();
			}
		} finally {
			if (this.services.panels.pendingModal === modal)
				this.services.panels.pendingModal = undefined;
			if (current()) this.services.changed();
		}
	}
	private beginOAuth(
		identity: Identity,
		provider: string,
		loginId: string,
		generation: number,
	): OAuthOperation {
		const key = `${identity.profile_id}:${provider}`;
		clearTimeout(this.oauthOperations.get(key)?.timer);
		const operation: OAuthOperation = {
			identity,
			provider,
			loginId,
			generation,
			modal: this.services.panels.modal,
		};
		this.oauthOperations.set(key, operation);
		this.displayedOAuth = operation;
		return operation;
	}
	private oauthActive(operation: OAuthOperation): boolean {
		return (
			this.services.hostActive(operation.identity) &&
			this.oauthOperations.get(
				`${operation.identity.profile_id}:${operation.provider}`,
			) === operation
		);
	}
	private oauthVisible(operation: OAuthOperation): boolean {
		const modal = this.services.panels.modal;
		return (
			this.oauthActive(operation) &&
			operation.generation === this.services.panels.generation &&
			operation.modal !== undefined &&
			modal?.id === operation.modal.id &&
			modal.data === operation.modal.data
		);
	}
	private pollOAuth(operation: OAuthOperation, delay = 750): void {
		clearTimeout(operation.timer);
		operation.timer = setTimeout(() => {
			if (!this.oauthActive(operation)) return;
			void this.services.client
				.call("GET /api/v1/accounts/oauth/{login_id}", {
					path: { login_id: operation.loginId },
					identity: operation.identity,
				})
				.then((value) => this.observeOAuth(operation, value))
				.catch((error) => {
					if (!this.oauthActive(operation)) return;
					if (this.oauthVisible(operation)) this.services.error(error);
					this.pollOAuth(operation, 1500);
				});
		}, delay);
	}
	private observeOAuth(operation: OAuthOperation, login: OAuthView): void {
		if (
			login.login_id !== operation.loginId ||
			login.provider !== operation.provider
		)
			throw new Error("授权回执归属不匹配，原记录已保留");
		if (!this.oauthActive(operation)) return;
		operation.view = login;
		if (this.oauthVisible(operation)) {
			const auth = this.authentication(login);
			operation.modal = providerLoginModal(
				this.services.locale(),
				auth,
				auth.login,
			);
			this.services.panels.modal = operation.modal;
			this.services.changed();
		}
		clearTimeout(operation.timer);
		if (login.phase === "pending") this.pollOAuth(operation);
		else {
			this.forgetOAuth(operation.identity, login);
			void this.services.refresh().catch((error) => {
				if (this.oauthVisible(operation)) this.services.error(error);
			});
		}
	}
	async cancelOAuth(loginId: string | undefined): Promise<void> {
		const login = this.modalOAuth,
			previous = this.displayedOAuth;
		if (!login || !previous || login.login_id !== loginId) return;
		const operation = this.beginOAuth(
			previous.identity,
			login.provider,
			login.login_id,
			previous.generation,
		);
		operation.view = login;
		let result: OAuthView;
		try {
			result = await this.services.client.call(
				"DELETE /api/v1/accounts/oauth/{login_id}",
				{
					path: { login_id: login.login_id },
					identity: operation.identity,
				},
			);
		} catch (error) {
			if (this.oauthActive(operation) && login.phase === "pending")
				this.pollOAuth(operation);
			throw error;
		}
		this.observeOAuth(operation, result);
		if (
			result.phase !== "pending" &&
			result.phase !== "unknown" &&
			this.oauthVisible(operation)
		) {
			this.services.panels.modal = undefined;
			this.services.changed();
		}
	}
	private forgetOAuth(identity: Identity, login: OAuthView): void {
		if (login.phase === "pending" || login.phase === "unknown") return;
		const key = `amazme:oauth:${identity.profile_id}:${login.provider}`,
			stored = sessionStorage.getItem(key);
		if (
			stored &&
			parseContract("OAuthStart", JSON.parse(stored)).login_id ===
				login.login_id
		)
			sessionStorage.removeItem(key);
	}
}
