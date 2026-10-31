import type {
	Identity,
	McpConfiguration,
	McpState,
	OAuthView,
	PluginPackages,
	PluginView,
} from "../generated/contracts.ts";
import * as P from "../panels.ts";
import { definitive, isRecord, parseContract } from "../transport/api.ts";
import { newId } from "./pending/writes.ts";
import type { PageServices } from "./services.ts";

export class Integrations {
	pluginPackages?: PluginPackages;
	pluginRuntime: PluginView[] = [];
	pluginsGeneration = 0;
	mcpConfiguration?: McpConfiguration;
	mcpRuntime?: McpState;
	mcpLogin?: OAuthView;
	mcpLoginTimer?: ReturnType<typeof setTimeout>;
	mcpLoginGeneration = 0;
	private readonly services: PageServices;
	constructor(services: PageServices) {
		this.services = services;
	}
	dispose(): void {
		this.pluginsGeneration++;
		this.mcpLoginGeneration++;
		clearTimeout(this.mcpLoginTimer);
	}
	async loadPlugins(): Promise<void> {
		const connection = this.services.client.connection,
			identity = this.services.client.identity,
			generation = ++this.pluginsGeneration;
		const [packages, runtime, config, mcp] = await Promise.all([
			this.services.client.call("GET /api/v1/plugin-packages", { identity }),
			connection
				? this.services.client.call("GET /api/v1/plugins", {
						query: { session_id: connection.sessionId },
					})
				: undefined,
			connection
				? this.services.client.call(
						"GET /api/v1/sessions/{session_id}/mcp-configuration",
						{ path: { session_id: connection.sessionId } },
					)
				: this.services.client.call("GET /api/v1/mcp-configuration"),
			connection
				? this.services.client.call("GET /api/v1/sessions/{session_id}/mcp", {
						path: { session_id: connection.sessionId },
					})
				: undefined,
		]);
		if (
			identity !== this.services.client.identity ||
			generation !== this.pluginsGeneration ||
			connection !== this.services.client.connection
		)
			return;
		this.pluginPackages = packages;
		this.pluginRuntime = runtime?.plugins ?? [];
		this.mcpConfiguration = config;
		this.mcpRuntime = mcp;
	}
	async mcpAction(action: P.PanelAction): Promise<boolean> {
		if (action.kind === "open" || action.kind === "modal-close") return false;
		const { id, data } = action,
			fields = action.kind === "modal-submit" ? action.fields : {};
		if (
			[
				P.PLUGIN_MCP_LOGIN_ACTION,
				P.PLUGIN_MCP_LOGIN_OPEN_ACTION,
				P.PLUGIN_MCP_LOGIN_REDIRECT_ACTION,
				P.PLUGIN_MCP_LOGIN_CANCEL_ACTION,
				P.PLUGIN_MCP_LOGIN_MODAL,
			].includes(id)
		) {
			await this.mcpLoginAction(action);
			return true;
		}
		if (
			![
				P.PLUGIN_MCP_ADD_ACTION,
				P.PLUGIN_MCP_MODAL,
				P.PLUGIN_MCP_ENABLED_ACTION,
				P.PLUGIN_MCP_EXPOSURE_ACTION,
				P.PLUGIN_MCP_REMOVE_ACTION,
				P.PLUGIN_MCP_RELOAD_ACTION,
				P.PLUGIN_MCP_RECONNECT_ACTION,
				P.PLUGIN_MCP_PROJECT_ACTION,
				P.PLUGIN_MCP_PROJECT_MODAL,
				"plugins:mcp-remove-confirm",
			].includes(id)
		)
			return false;
		const connection = this.services.client.connection,
			identity = this.services.client.identity,
			modal = this.services.panels.modal;
		if (!identity) throw new Error("请先连接后端");
		if (connection && !connection.ready)
			throw new Error("请等待原会话重新连接");
		const ledger = connection
				? this.services.ledger(connection)
				: this.services.hostLedger(identity),
			binding = connection ?? identity;
		const path = connection ? { session_id: connection.sessionId } : {},
			config = this.mcpConfiguration;
		const globalLedger = this.services.hostLedger(identity);
		if (!config) throw new Error("请等待 MCP 配置加载完成");
		const target = config.servers.find((item) => item.name === data);
		if (id === P.PLUGIN_MCP_ADD_ACTION) {
			const previous = globalLedger.read(
				"mcp:save",
				"POST /api/v1/mcp-configuration",
			);
			this.services.panels.modal = P.addMcpServerModal(this.services.locale());
			if (previous)
				this.services.panels.modal = {
					...this.services.panels.modal,
					notice: {
						tone: "info",
						text: "上次配置尚待确认；提交将沿用原编号和内容。",
					},
					fields: this.services.panels.modal.fields.map((field) => ({
						...field,
						value:
							field.id === "name"
								? previous.body.name
								: JSON.stringify(previous.body.entry, null, 2),
						readOnly: true,
					})),
				};
			this.services.changed();
			return true;
		}
		if (id === P.PLUGIN_MCP_PROJECT_ACTION) {
			if (!connection) throw new Error("请先选择项目会话");
			if (!target) throw new Error("MCP 配置不存在");
			this.services.panels.modal = P.mcpProjectModal(
				this.services.locale(),
				target,
			);
			this.services.panels.modal = {
				...this.services.panels.modal,
				data: JSON.stringify({ name: target.name, revision: config.revision }),
			};
			this.services.changed();
			return true;
		}
		if (id === P.PLUGIN_MCP_REMOVE_ACTION) {
			if (!target) throw new Error("MCP 配置不存在");
			this.services.panels.modal = {
				id: "plugins:mcp-remove-confirm",
				title: "移除 MCP 服务",
				description: `停止配置所属连接并移除 ${target.name}，原调用结果保留。`,
				fields: [],
				danger: true,
				submit: "移除",
				data: JSON.stringify({ name: target.name, revision: config.revision }),
			};
			this.services.changed();
			return true;
		}
		if (id === P.PLUGIN_MCP_MODAL) {
			if (modal?.id !== id) return true;
			const record = globalLedger.prepare(
				"mcp:save",
				"POST /api/v1/mcp-configuration",
				(operationId) => ({
					path: {},
					body: parseContract("McpConfigWrite", {
						operation_id: operationId,
						expected_revision: config.revision,
						name: fields.name ?? "",
						entry: JSON.parse(fields.entry ?? "null"),
					}),
				}),
			);
			await globalLedger.send(
				"mcp:save",
				record,
				this.services.client,
				identity,
			);
		} else if (id === P.PLUGIN_MCP_RELOAD_ACTION) {
			if (connection)
				await this.services.client.call(
					"POST /api/v1/sessions/{session_id}/mcp-configuration/reload",
					{ path: { session_id: connection.sessionId }, connection },
				);
		} else if (id === P.PLUGIN_MCP_RECONNECT_ACTION) {
			if (!connection) throw new Error("请先选择会话，再连接 MCP 服务");
			if (!target) throw new Error("MCP 配置不存在");
			const key = `mcp:reconnect:${target.name}`;
			await ledger.send(
				key,
				ledger.prepare(
					key,
					"POST /api/v1/sessions/{session_id}/mcp-configuration/reconnect",
					(operationId) => ({
						path: { session_id: connection.sessionId },
						body: { operation_id: operationId, name: target.name },
					}),
				),
				this.services.client,
				connection,
			);
		} else {
			let name = target?.name,
				revision = config.revision,
				scope: "global" | "project" = "global";
			if (
				id === P.PLUGIN_MCP_PROJECT_MODAL ||
				id === "plugins:mcp-remove-confirm"
			) {
				if (modal?.id !== id || modal.data !== data) return true;
				const original: unknown = JSON.parse(data ?? "null");
				if (
					!isRecord(original) ||
					typeof original.name !== "string" ||
					typeof original.revision !== "number"
				)
					throw new Error("MCP 配置归属损坏");
				name = original.name;
				revision = original.revision;
				scope = id === P.PLUGIN_MCP_PROJECT_MODAL ? "project" : "global";
			}
			if (!name) throw new Error("MCP 配置不存在");
			if (scope === "project" && !connection)
				throw new Error("请先选择项目会话");
			const enabled =
				id === P.PLUGIN_MCP_ENABLED_ACTION
					? action.kind === "control" && action.value === "true"
					: id === P.PLUGIN_MCP_PROJECT_MODAL
						? fields.enabled === "true"
						: undefined;
			const exposure =
				id === P.PLUGIN_MCP_EXPOSURE_ACTION
					? action.kind === "control"
						? action.value
						: undefined
					: id === P.PLUGIN_MCP_PROJECT_MODAL
						? fields.exposure
						: undefined;
			const key = `mcp:patch:${scope}:${name}:${id}`;
			const patchLedger = scope === "project" ? ledger : globalLedger;
			const patchOperation =
				scope === "project"
					? "PATCH /api/v1/sessions/{session_id}/mcp-configuration"
					: "PATCH /api/v1/mcp-configuration";
			const record = patchLedger.prepare(
				key,
				patchOperation,
				(operationId) => ({
					path: scope === "project" ? path : {},
					body: parseContract("McpConfigPatch", {
						operation_id: operationId,
						expected_revision: revision,
						name,
						scope,
						...(enabled === undefined ? {} : { enabled }),
						...(exposure === undefined ? {} : { exposure }),
						remove: id === "plugins:mcp-remove-confirm",
					}),
				}),
			);
			await patchLedger.send(
				key,
				record,
				this.services.client,
				scope === "project" ? binding : identity,
			);
		}
		await this.loadPlugins();
		if (this.services.panels.modal === modal)
			this.services.panels.modal = undefined;
		this.services.changed();
		return true;
	}
	private async mcpLoginAction(action: P.PanelAction): Promise<void> {
		if (action.kind === "open" || action.kind === "modal-close") return;
		const identity = this.services.client.identity,
			{ id, data } = action;
		if (!identity) throw new Error("请先连接后端");
		if (id === P.PLUGIN_MCP_LOGIN_OPEN_ACTION) {
			if (!data || data !== this.mcpLogin?.url || !/^https?:\/\//.test(data))
				throw new Error("授权链接已变化");
			window.open(data, "_blank", "noopener,noreferrer");
			return;
		}
		if (id === P.PLUGIN_MCP_LOGIN_ACTION) {
			const config = this.mcpConfiguration,
				server = config?.servers.find((item) => item.name === data);
			if (!config || !server?.can_login) throw new Error("MCP 未配置 OAuth");
			const key = `amazme:mcp-login:${identity.profile_id}:${server.name}`,
				raw = sessionStorage.getItem(key);
			const request = raw
				? parseContract("McpLoginRequest", JSON.parse(raw))
				: {
						login_id: newId(),
						name: server.name,
						expected_revision: config.revision,
					};
			if (!raw) sessionStorage.setItem(key, JSON.stringify(request));
			const generation = ++this.mcpLoginGeneration;
			clearTimeout(this.mcpLoginTimer);
			const result = await this.services.client.call(
				"POST /api/v1/mcp-configuration/logins",
				{ body: request, identity },
			);
			this.showMcpLogin(
				identity,
				request.name,
				request.login_id,
				result,
				generation,
			);
			return;
		}
		const login = this.mcpLogin,
			generation = this.mcpLoginGeneration;
		if (!login || data !== login.login_id)
			throw new Error("原授权已变化，请核对当前记录");
		if (id === P.PLUGIN_MCP_LOGIN_REDIRECT_ACTION) {
			this.services.panels.modal = {
				id: P.PLUGIN_MCP_LOGIN_MODAL,
				title: "完成 MCP 登录",
				description: "粘贴浏览器中的完整回调地址。",
				fields: [{ id: "value", label: "回调地址", kind: "text", value: "" }],
				submit: "确认",
				data: login.login_id,
			};
			this.services.changed();
			return;
		}
		if (id === P.PLUGIN_MCP_LOGIN_MODAL && action.kind === "modal-submit") {
			const modal = this.services.panels.modal;
			if (modal?.id !== id || modal.data !== data) return;
			const result = await this.services.client.call(
				"POST /api/v1/mcp-configuration/logins/{login_id}/input",
				{
					path: { login_id: login.login_id },
					body: { value: action.fields.value ?? "" },
					identity,
				},
			);
			this.showMcpLogin(
				identity,
				login.provider,
				login.login_id,
				result,
				generation,
			);
			if (
				this.services.hostActive(identity) &&
				generation === this.mcpLoginGeneration &&
				this.services.panels.modal === modal
			) {
				this.services.panels.modal = undefined;
				this.services.changed();
			}
			return;
		}
		if (id === P.PLUGIN_MCP_LOGIN_CANCEL_ACTION) {
			const result = await this.services.client.call(
				"DELETE /api/v1/mcp-configuration/logins/{login_id}",
				{ path: { login_id: login.login_id }, identity },
			);
			this.showMcpLogin(
				identity,
				login.provider,
				login.login_id,
				result,
				generation,
			);
		}
	}
	private showMcpLogin(
		identity: Identity,
		name: string,
		loginId: string,
		result: OAuthView,
		generation: number,
	): void {
		if (result.login_id !== loginId || result.provider !== name)
			throw new Error("MCP 授权回执归属不匹配；原编号已保留");
		const key = `amazme:mcp-login:${identity.profile_id}:${name}`,
			raw = sessionStorage.getItem(key);
		if (
			raw &&
			parseContract("McpLoginRequest", JSON.parse(raw)).login_id === loginId &&
			result.phase !== "pending" &&
			result.phase !== "unknown"
		)
			sessionStorage.removeItem(key);
		if (
			!this.services.hostActive(identity) ||
			generation !== this.mcpLoginGeneration
		)
			return;
		this.mcpLogin = result;
		clearTimeout(this.mcpLoginTimer);
		this.services.changed();
		if (result.phase === "pending")
			this.mcpLoginTimer = setTimeout(() => {
				if (
					!this.services.hostActive(identity) ||
					generation !== this.mcpLoginGeneration ||
					this.mcpLogin?.login_id !== loginId
				)
					return;
				void this.services.client
					.call("GET /api/v1/mcp-configuration/logins/{login_id}", {
						path: { login_id: loginId },
						identity,
					})
					.then((value) =>
						this.showMcpLogin(identity, name, loginId, value, generation),
					)
					.catch((error) => {
						if (
							this.services.hostActive(identity) &&
							generation === this.mcpLoginGeneration
						)
							this.services.error(error);
					});
			}, 1000);
	}
	async pluginAction(action: P.PanelAction): Promise<boolean> {
		if (action.kind === "open" || action.kind === "modal-close") return false;
		const { id, data } = action,
			fields = action.kind === "modal-submit" ? action.fields : {};
		if (
			![
				P.PLUGIN_PACKAGE_ADD_ACTION,
				P.PLUGIN_PACKAGE_MODAL,
				P.PLUGIN_PACKAGE_REMOVE_ACTION,
				"plugins:package-remove-confirm",
				"plugins:package-reload",
			].includes(id)
		)
			return false;
		const identity = this.services.client.identity,
			connection = this.services.client.connection,
			modal = this.services.panels.modal;
		if (!identity) throw new Error("请先连接后端");
		const key = `amazme:plugin-package:${identity.profile_id}`,
			raw = sessionStorage.getItem(key);
		if (id === P.PLUGIN_PACKAGE_ADD_ACTION) {
			this.services.panels.modal = P.addPackageModal(this.services.locale());
			this.services.panels.modal = {
				...this.services.panels.modal,
				description: "选择 Python 插件入口文件，或含 extension.py 的目录。",
				fields: this.services.panels.modal.fields.map((field) =>
					field.id === "path"
						? {
								...field,
								value: raw
									? parseContract("PluginPackageAdd", JSON.parse(raw)).entry
									: "",
								placeholder: "/path/to/extension.py",
							}
						: field,
				),
				...(raw
					? {
							notice: {
								tone: "info",
								text: "上次添加尚待确认；提交将沿用原路径与编号。",
							},
						}
					: {}),
			};
			this.services.changed();
			return true;
		}
		const target = this.pluginPackages?.packages.find(
			(item) => item.entry === data,
		);
		if (id === P.PLUGIN_PACKAGE_REMOVE_ACTION) {
			if (!target || !this.pluginPackages) throw new Error("插件配置不存在");
			this.services.panels.modal = {
				id: "plugins:package-remove-confirm",
				title: "移除插件",
				description: `停止此配置在各会话中的插件进程并移除配置：${target.entry}`,
				fields: [],
				submit: "移除",
				danger: true,
				data: JSON.stringify({
					id: target.package_id,
					revision: this.pluginPackages.revision,
				}),
			};
			this.services.changed();
			return true;
		}
		if (id === P.PLUGIN_PACKAGE_MODAL) {
			if (modal?.id !== id) return true;
			const request =
				raw ??
				JSON.stringify({
					package_id: newId(),
					entry: fields.path ?? "",
					expected_revision: this.pluginPackages?.revision ?? 0,
				});
			const body = parseContract("PluginPackageAdd", JSON.parse(request));
			sessionStorage.setItem(key, request);
			try {
				await this.services.client.call("POST /api/v1/plugin-packages", {
					body,
					identity,
				});
				if (sessionStorage.getItem(key) === request) {
					sessionStorage.removeItem(key);
					sessionStorage.removeItem(key + ":uncertain");
				}
			} catch (error) {
				if (sessionStorage.getItem(key) === request) {
					if (!definitive(error))
						sessionStorage.setItem(key + ":uncertain", body.package_id);
					else if (
						sessionStorage.getItem(key + ":uncertain") !== body.package_id
					)
						sessionStorage.removeItem(key);
				}
				throw error;
			}
			if (connection?.active())
				await this.services.client.call(
					"POST /api/v1/sessions/{session_id}/plugin-packages/load",
					{ path: { session_id: connection.sessionId }, connection },
				);
		} else if (id === "plugins:package-remove-confirm") {
			if (modal?.id !== id || modal.data !== data) return true;
			const target: unknown = JSON.parse(data ?? "null");
			if (
				!isRecord(target) ||
				typeof target.id !== "string" ||
				typeof target.revision !== "number"
			)
				throw new Error("插件配置归属损坏");
			await this.services.client.call(
				"POST /api/v1/plugin-packages/{package_id}/remove",
				{
					path: { package_id: target.id },
					body: { expected_revision: target.revision },
					identity,
				},
			);
		} else if (id === "plugins:package-reload") {
			if (!target) throw new Error("插件配置不存在");
			const selected = this.services.connection(),
				runtime = this.pluginRuntime.find(
					(item) => item.package_id === target.package_id,
				);
			if (runtime) {
				const ledger = this.services.ledger(selected),
					key = `plugin:reload:${runtime.plugin_id}`;
				await ledger.send(
					key,
					ledger.prepare(
						key,
						"POST /api/v1/plugins/{plugin_id}/reload",
						(reloadId) => ({
							path: { plugin_id: runtime.plugin_id },
							body: { session_id: selected.sessionId, reload_id: reloadId },
						}),
					),
					this.services.client,
					selected,
				);
			} else
				await this.services.client.call(
					"POST /api/v1/sessions/{session_id}/plugin-packages/load",
					{ path: { session_id: selected.sessionId }, connection: selected },
				);
		}
		await this.loadPlugins();
		if (this.services.panels.modal === modal)
			this.services.panels.modal = undefined;
		this.services.changed();
		return true;
	}
	pluginPanelState(
		packages: PluginPackages | undefined,
		plugins: readonly PluginView[],
		canLoad: boolean,
		mcpPath: string,
	): P.PluginsStateLike | undefined {
		if (!packages) return undefined;
		return {
			packages: packages.packages.map((item) => item.entry),
			packageDetails: Object.fromEntries(
				packages.packages.map((item) => {
					const runtime = plugins.find(
						(plugin) => plugin.package_id === item.package_id,
					);
					const detail =
						item.phase === "removing"
							? "移除等待资源退出，请重试移除"
							: runtime
								? `${runtime.phase} · ${runtime.tools?.length ?? 0} 工具${runtime.error ? ` · ${runtime.error}` : ""}`
								: "已配置，将在会话执行时加载";
					return [
						item.entry,
						{ detail, canLoad: canLoad && item.phase === "installed" },
					];
				}),
			),
			mcp: { servers: [], errors: [], globalPath: mcpPath },
		};
	}

	mcpPanelRuntime(
		config: McpConfiguration | undefined,
		state: McpState | undefined,
		ready: boolean,
		canConnect: boolean,
		login?: OAuthView,
	): P.McpRuntimeLike | undefined {
		if (!config) return undefined;
		return {
			disabled: !ready,
			canConnect,
			canOverrideProject: Boolean(config.workspace),
			errors: [],
			login: login
				? {
						id: login.login_id,
						server: login.provider,
						status:
							login.phase === "pending"
								? login.url
									? "awaiting"
									: "preparing"
								: login.phase === "complete"
									? "done"
									: "failed",
						url: login.url || null,
						error: login.error || null,
					}
				: null,
			servers: config.servers.map((item) => {
				const live = state?.servers.find(
					(server) => server.managed_id === item.config_id && server.enabled,
				);
				return {
					name: item.name,
					detail: item.detail,
					state: !item.enabled
						? "disabled"
						: live?.phase === "ready"
							? "connected"
							: (live?.phase ?? "disconnected"),
					tools: live?.tools.length ?? 0,
					enabled: item.enabled,
					exposure: item.exposure,
					scope: item.scope,
					canLogin: item.can_login === true,
					error:
						live?.phase === "unknown"
							? "连接结果待核对；显式重连会先核对原资源退出。"
							: null,
				};
			}),
		};
	}
}
