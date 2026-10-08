import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@amazme/chord/context";
import type { McpUi } from "../core/mcp/view.ts";
import type { McpExposure } from "../core/mcp-servers.ts";
import { openBrowser } from "../utils/open-browser.ts";
import type { McpManagement } from "../core/mcp/management.ts";

/** Both state and actions come from the same manager used by tool execution. */
export async function manageMcp(ui: McpUi, manager: McpManagement, chinese: boolean): Promise<void> {
	const text = (zh: string, en: string) => (chinese ? zh : en);
	const stateLabel = (state: string): string =>
		text(
			(
				{
					connecting: "连接中",
					connected: "已连接",
					disconnected: "已断开",
					disabled: "已禁用",
					"needs-auth": "需要登录",
					failed: "连接失败",
					closed: "已关闭",
				} as Record<string, string>
			)[state] ?? state,
			state,
		);
	const exposureLabel = (exposure: McpExposure): string =>
		text({ direct: "直接", codemode: "代码模式", deferred: "延迟", hidden: "隐藏" }[exposure], exposure);
	let error: string | undefined;
	for (;;) {
		const selection = await ui.menu(
			() => {
				const state = manager.snapshot();
				return {
					title: text("MCP 服务器", "MCP servers"),
					error: error ?? state.errors.join("\n"),
					confirmLabel: text("管理", "manage"),
					cancelLabel: text("关闭", "close"),
					items: [
						...state.servers.map((server) => ({
							value: `server:${server.name}`,
							label: server.name,
							description: `${stateLabel(server.state)} · ${exposureLabel(server.exposure)} · ${server.tools} ${text("工具", "tools")}`,
						})),
						{ value: "reload", label: text("重新加载配置", "Reload configuration") },
					],
					details: state.disabled ? text("此轮已禁用 MCP", "MCP is disabled for this run") : undefined,
				};
			},
			(listener) => manager.subscribe(listener),
		);
		if (!selection) return;
		const name = selection.slice("server:".length);
		try {
			if (selection === "reload") {
				ui.status(text("MCP", "MCP"), text("正在加载配置…", "Loading configuration…"));
				await manager.reload(context);
				error = undefined;
				continue;
			}
			error = undefined;
			for (;;) {
				const server = manager.snapshot().servers.find((value) => value.name === name);
				if (!server) break;
				const action = await ui.menu(
					() => {
						const server = manager.snapshot().servers.find((value) => value.name === name);
						if (!server)
							return {
								title: name,
								items: [],
								confirmLabel: text("选择", "select"),
								cancelLabel: text("返回", "back"),
							};
						return {
							title: name,
							details: `${stateLabel(server.state)} · ${server.scope === "global" ? text("全局", "global") : text("项目", "project")} · ${server.tools} ${text("工具", "tools")}`,
							error:
								error ??
								server.error ??
								(manager.snapshot().login?.server === name ? manager.snapshot().login?.error : undefined) ??
								undefined,
							confirmLabel: text("选择", "select"),
							cancelLabel: text("返回", "back"),
							items: [
								{
									value: server.enabled ? "disable" : "enable",
									label: server.enabled ? text("禁用", "Disable") : text("启用", "Enable"),
								},
								{
									value: "exposure",
									label: text("工具暴露方式", "Tool exposure"),
									description: exposureLabel(server.exposure),
								},
								...(server.enabled ? [{ value: "reconnect", label: text("重连", "Reconnect") }] : []),
								...(server.canLogin ? [{ value: "login", label: text("登录", "Sign in") }] : []),
								...(server.scope === "global" && manager.snapshot().canOverrideProject
									? [{ value: "project", label: text("仅在此项目设置", "Configure this project") }]
									: []),
							],
						};
					},
					(listener) => manager.subscribe(listener),
				);
				if (!action) break;
				const inProject = action === "project";
				if (inProject) {
					const selected = await ui.menu(() => ({
						title: text("仅在此项目设置", "Configure this project"),
						confirmLabel: text("保存", "save"),
						cancelLabel: text("返回", "back"),
						items: [
							{ value: "enable", label: text("启用", "Enable") },
							{ value: "disable", label: text("禁用", "Disable") },
							...["direct", "codemode", "deferred", "hidden"].map((value) => ({
								value,
								label: exposureLabel(value as McpExposure),
							})),
						],
					}));
					if (!selected) continue;
					await manager.configure(
						name,
						selected === "enable" || selected === "disable"
							? { enabled: selected === "enable" }
							: { exposure: selected as McpExposure },
						true,
						context,
					);
				} else if (action === "exposure") {
					const exposure = await ui.menu(() => ({
						title: text("工具暴露方式", "Tool exposure"),
						confirmLabel: text("保存", "save"),
						cancelLabel: text("返回", "back"),
						selected: server.exposure,
						items: ["direct", "codemode", "deferred", "hidden"].map((value) => ({
							value,
							label: exposureLabel(value as McpExposure),
						})),
					}));
					if (exposure) await manager.configure(name, { exposure: exposure as McpExposure }, false, context);
				} else if (action === "enable" || action === "disable")
					await manager.configure(name, { enabled: action === "enable" }, false, context);
				else if (action === "reconnect") {
					ui.status(name, text("正在重连…", "Reconnecting…"));
					await manager.reconnect(name, context);
				} else if (action === "login") {
					const cancelled = new AbortController();
					ui.status(name, text("正在准备登录…", "Preparing sign-in…"), () => cancelled.abort());
					const id = await manager.startLogin(name, withAbortSignal(cancelled.signal, context));
					const login = manager.snapshot().login;
					if (login?.id === id && login.url) {
						const finished = new AbortController();
						const unsubscribe = manager.subscribe(() => {
							if (manager.snapshot().login?.status !== "awaiting") finished.abort();
						});
						try {
							openBrowser(login.url);
							const redirect = await ui.redirectUrl(name, login.url, finished.signal);
							if (redirect) await manager.submitRedirect(id, redirect, context);
							else if (manager.snapshot().login?.status === "awaiting") await manager.cancelLogin(id);
						} finally {
							unsubscribe();
						}
					}
				}
				error = undefined;
			}
		} catch (failure) {
			error = failure instanceof Error ? failure.message : String(failure);
		}
	}
}
