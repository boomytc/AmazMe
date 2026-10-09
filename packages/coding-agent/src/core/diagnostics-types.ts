/** A point-in-time, local observation. No credential values or raw parser errors cross this boundary. */
export type DiagnosticCode =
	| "readable"
	| "missing"
	| "invalid"
	| "unreadable"
	| "notWritable"
	| "notDirectory"
	| "configured"
	| "unconfigured"
	| "oauthExpired"
	| "commandDeferred"
	| "untrusted"
	| "hostRunning"
	| "hostUnchecked"
	| "unsupportedNode"
	| "ambientUnchecked"
	| "disabled"
	| "patternUnchecked"
	| "requestAuthUnchecked"
	| "integrityUnchecked"
	| "clientLoaded";

export interface DiagnosticEntry {
	readonly area: "config" | "auth" | "host" | "mcp" | "storage" | "resources";
	readonly target: string;
	readonly level: "info" | "warning" | "error";
	readonly code: DiagnosticCode;
}

export interface DiagnosticReport {
	readonly version: 1;
	readonly generatedAt: number;
	readonly entries: readonly DiagnosticEntry[];
}

const messages: Record<DiagnosticCode, readonly [string, string]> = {
	integrityUnchecked: [
		"Directory access was checked; session databases were not opened or checked for integrity.",
		"已检查目录访问；未打开会话数据库或检查数据库完整性。",
	],
	clientLoaded: [
		"This client's page entry is running and the host answered. Stylesheet availability is listed separately.",
		"当前客户端页面已运行，宿主已响应。样式资源的可用性单独列出。",
	],
	requestAuthUnchecked: [
		"Custom provider has no explicit key. Header, proxy, and anonymous authentication were not resolved; check its normal request flow.",
		"自定义供应商未配置显式密钥。未解析请求头、代理或匿名鉴权；请检查其正常请求流程。",
	],
	readable: ["Readable.", "可读取。"],
	missing: [
		"Missing. Optional files use defaults; restore this path if you configured it.",
		"不存在。可选文件采用默认值；已配置的路径需要恢复。",
	],
	invalid: [
		"Invalid content. Repair this file's JSON or configuration shape, then run diagnostics again.",
		"内容无效。修复该文件的 JSON 或配置结构后重新诊断。",
	],
	unreadable: [
		"Cannot read. Check the path, ownership, and read/search permissions.",
		"无法读取。检查路径、所有者及读取和目录访问权限。",
	],
	notWritable: [
		"Cannot write. Check directory ownership and write/search permissions before saving.",
		"无法写入。保存前检查目录所有者及写入和目录访问权限。",
	],
	notDirectory: [
		"Expected a directory. Correct this path or move the conflicting file.",
		"应为目录。修正路径或移走冲突文件。",
	],
	configured: [
		"Configured locally; vendor acceptance and connectivity were not checked.",
		"本地已配置；尚未验证供应商接受情况与连通性。",
	],
	unconfigured: [
		"No usable local key found. Sign in with amazme auth or configure the provider's environment/key.",
		"未发现可用本地密钥。使用 amazme auth 登录，或配置供应商的环境变量或密钥。",
	],
	oauthExpired: [
		"OAuth token expired. Normal requests may refresh it; sign in again if refresh fails. Diagnostics did not refresh it.",
		"OAuth 令牌已过期。正常请求可能刷新；刷新失败时重新登录。诊断未执行刷新。",
	],
	commandDeferred: [
		"Key command configured but not executed. Verify it separately if requests cannot authenticate.",
		"已配置密钥命令，未执行。请求鉴权失败时另行检查该命令。",
	],
	untrusted: [
		"Project configuration is not active. Review the project before granting trust.",
		"项目配置未激活。检查项目后再授予信任。",
	],
	hostRunning: [
		"This host answered the diagnostic request. Workers and remote connectivity were not probed.",
		"当前宿主已响应诊断请求。未探测 worker 或远程连通性。",
	],
	hostUnchecked: [
		"Host connectivity was not probed. Use the connected Web diagnostics or inspect the host explicitly.",
		"未探测宿主连通性。使用已连接的 Web 诊断，或单独检查宿主。",
	],
	unsupportedNode: [
		"Node.js 22.19 or newer is required. Upgrade Node.js before starting AmazMe.",
		"需要 Node.js 22.19 或更高版本。启动 AmazMe 前升级 Node.js。",
	],
	ambientUnchecked: [
		"Ambient IAM/ADC credentials were not resolved. Check the provider's normal authentication flow.",
		"未解析 IAM/ADC 等环境凭据。请通过供应商的正常鉴权流程检查。",
	],
	disabled: [
		"Disabled in configuration; no connection was attempted.",
		"配置中已停用；未尝试连接。",
	],
	patternUnchecked: [
		"Resource exclusion or glob pattern was not expanded. Inspect loaded resources in the normal client.",
		"未展开资源排除或匹配模式。请在正常客户端检查加载结果。",
	],
};

/** The same copyable report serves the CLI and the Web dialog without importing Node into the page. */
export function formatDiagnosticReport(
	report: DiagnosticReport,
	locale: "en" | "zh" = "en",
): string {
	const zh = locale === "zh";
	const levels = zh
		? { info: "信息", warning: "注意", error: "错误" }
		: { info: "INFO", warning: "WARN", error: "ERROR" };
	const areas = zh
		? {
				config: "配置",
				auth: "凭据",
				host: "宿主",
				mcp: "MCP",
				storage: "存储",
				resources: "资源",
			}
		: {
				config: "config",
				auth: "auth",
				host: "host",
				mcp: "mcp",
				storage: "storage",
				resources: "resources",
			};
	const errors = report.entries.filter(
		(entry) => entry.level === "error",
	).length;
	return [
		zh ? "AmazMe 本地只读诊断" : "AmazMe local read-only diagnostics",
		new Date(report.generatedAt).toISOString(),
		zh
			? `错误：${errors}；未发送模型请求、启动 MCP、执行密钥命令或刷新 OAuth。`
			: `Errors: ${errors}; no model requests, MCP startup, key commands, or OAuth refresh.`,
		"",
		...report.entries.map(
			(entry) =>
				`[${levels[entry.level]}] ${areas[entry.area]}: ${entry.target}\n  ${messages[entry.code][zh ? 1 : 0]}`,
		),
	].join("\n");
}
