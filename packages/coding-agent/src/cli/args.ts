/**
 * CLI argument parsing and help display
 */

import type { ThinkingLevel } from "@amazme/agent";
import chalk from "chalk";
import { APP_COMMAND, APP_NAME } from "../config.ts";
import type { ExtensionFlag } from "../core/extensions/types.ts";
import { getToolListError, type TuiMode } from "../core/settings-manager.ts";
import { getToolSelectionError } from "../core/tool-selection.ts";

export type Mode = "text" | "json" | "rpc";

export interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	name?: string;
	noSession?: boolean;
	sessionDir?: string;
	/** Open one exact existing Durable session by ID or session directory. */
	session?: string;
	models?: string[];
	tools?: string[];
	excludeTools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	noMcp?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	useTheme?: string;
	noThemes?: boolean;
	noContextFiles?: boolean;
	listModels?: string | true;
	offline?: boolean;
	tuiMode?: TuiMode;
	/** Explicit Python host. Interactive mode uses this instead of the old runtime. */
	pythonUrl?: string;
	pythonToken?: string;
	pythonSession?: string;
	decision?: string;
	request?: string;
	call?: string;
	workspace?: string;
	verbose?: boolean;
	projectTrustOverride?: boolean;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

export function normalizeSessionName(value: string): string | undefined {
	const name = value.trim();
	return name.length > 0 ? name : undefined;
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--") {
			for (const positionalArg of args.slice(i + 1)) {
				if (positionalArg.startsWith("@")) {
					result.fileArgs.push(positionalArg.slice(1));
				} else {
					result.messages.push(positionalArg);
				}
			}
			break;
		} else if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--mode") {
			const mode = args[i + 1];
			if (mode === undefined || mode.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--mode requires text, json, or rpc" });
				continue;
			}
			i++;
			if (mode !== "text" && mode !== "json" && mode !== "rpc") {
				result.diagnostics.push({
					type: "error",
					message: `Invalid mode "${mode}". Valid values: text, json, rpc`,
				});
				continue;
			}
			result.mode = mode;
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = result.appendSystemPrompt ?? [];
			result.appendSystemPrompt.push(args[++i]);
		} else if (arg === "--name" || arg === "-n") {
			if (i + 1 < args.length) {
				result.name = args[++i];
			} else {
				result.diagnostics.push({ type: "error", message: "--name requires a value" });
			}
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];
		} else if (arg === "--session") {
			if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) result.session = args[++i];
			else result.diagnostics.push({ type: "error", message: "--session requires an ID or session directory" });
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((pattern) => pattern.length > 0);
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
			const tools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
			const error = getToolListError(tools);
			if (error) result.diagnostics.push({ type: "error", message: `Invalid tools option: ${error}` });
			else result.tools = tools;
		} else if ((arg === "--exclude-tools" || arg === "-xt") && i + 1 < args.length) {
			const excludeTools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
			const error = getToolSelectionError({ excludeTools });
			if (error) result.diagnostics.push({ type: "error", message: `Invalid tools option: ${error}` });
			else result.excludeTools = excludeTools;
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i];
			if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
				});
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
			result.extensions = result.extensions ?? [];
			result.extensions.push(args[++i]);
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;
		} else if (arg === "--no-mcp") {
			result.noMcp = true;
		} else if (arg === "--skill" && i + 1 < args.length) {
			result.skills = result.skills ?? [];
			result.skills.push(args[++i]);
		} else if (arg === "--prompt-template" && i + 1 < args.length) {
			result.promptTemplates = result.promptTemplates ?? [];
			result.promptTemplates.push(args[++i]);
		} else if (arg === "--theme" && i + 1 < args.length) {
			result.themes = result.themes ?? [];
			result.themes.push(args[++i]);
		} else if (arg === "--use-theme") {
			const themeName = args[i + 1];
			if (themeName === undefined || themeName.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--use-theme requires a theme name" });
			} else {
				result.useTheme = themeName;
				i++;
			}
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-themes") {
			result.noThemes = true;
		} else if (arg === "--no-context-files" || arg === "-nc") {
			result.noContextFiles = true;
		} else if (arg === "--list-models") {
			// Check if next arg is a search pattern (not a flag or file arg)
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg === "--tui-mode") {
			const mode = args[i + 1];
			if (mode === "regular" || mode === "fullscreen") {
				result.tuiMode = mode;
				i++;
			} else if (mode === undefined || mode.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--tui-mode requires regular or fullscreen" });
			} else {
				i++;
				result.diagnostics.push({
					type: "error",
					message: `Invalid TUI mode "${mode}". Valid values: regular, fullscreen`,
				});
			}
		} else if (arg === "--python-url" || arg === "--python-token" || arg === "--python-session" || arg === "--decision" || arg === "--request" || arg === "--call" || arg === "--workspace") {
			const value = args[i + 1];
			if (value === undefined || value.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: `${arg} requires a value` });
			} else {
				i++;
				if (arg === "--python-url") result.pythonUrl = value;
				else if (arg === "--python-token") result.pythonToken = value;
				else if (arg === "--python-session") result.pythonSession = value;
				else if (arg === "--decision") result.decision = value;
				else if (arg === "--request") result.request = value;
				else if (arg === "--call") result.call = value;
				else result.workspace = value;
			}
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg === "--approve" || arg === "-a") {
			result.projectTrustOverride = true;
		} else if (arg === "--no-approve" || arg === "-na") {
			result.projectTrustOverride = false;
		} else if (arg === "--offline") {
			result.offline = true;
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

export function printHelp(extensionFlags?: ExtensionFlag[]): void {
	const extensionFlagsText =
		extensionFlags && extensionFlags.length > 0
			? `\n${chalk.bold("Extension CLI Flags:")}\n${extensionFlags
					.map((flag) => {
						const value = flag.type === "string" ? " <value>" : "";
						const description = flag.description ?? `Registered by ${flag.extensionPath}`;
						return `  --${flag.name}${value}`.padEnd(30) + description;
					})
					.join("\n")}\n`
			: "";
	process.stdout.write(`${APP_NAME} — 本机桌面助手

用法：
  ${APP_COMMAND} [--print | --mode json | --mode rpc] [@文件...] [问题]
  ${APP_COMMAND} --session <会话编号> [问题]

命令：
  web | server [--port 0]           启动或连接本机 Python 服务并显示网页地址
  models [--search 关键词]          查看 Python 模型目录
  model --provider NAME --model ID  选择账号和模型
  accounts                         查看已配置的账号，不显示凭据
  auth login --provider NAME       启动 OAuth；原登录编号可查询或取消
  auth login --provider NAME --method api-key  从隐藏输入或 stdin 保存 key
  auth logout --provider NAME      删除对应账号凭据
  auth status|input|cancel --login-id ID  核对、补交授权输入或取消原登录
  export [--output 文件]            导出当前 profile 的新格式数据，不覆盖已有文件
  import 文件                      导入新格式数据，不覆盖冲突记录
  doctor                           查看 Python Host 健康状态
  client <命令>                    使用 Python CLI；client --help 查看参数

连接与输入：
  --python-url URL --python-token TOKEN  连接指定 Host
  --python-session ID | --session ID     打开指定会话
  --workspace NAME                       会话工作区（默认 primary）
  --decision 批准|拒绝 --request ID       对已保存的请求明确审批
  --decision 批准|拒绝 --call ID          对已保存的 MCP 调用明确审批
  --provider NAME --model ID [--api-key KEY]  配置账号后提交问题
  --list-models [关键词]                  查看模型
  --help | --version                      帮助或版本

交互客户端的终端和 MCP 命令保留原调用编号。离开客户端只释放绑定。
OAuth、模型、项目和设置由 Python Host 保存。旧 JSONL 会话不迁移。${extensionFlagsText}\n`);
}
