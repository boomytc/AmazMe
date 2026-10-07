/**
 * The page's copy, in both shipped languages. Everything a reader sees comes from here: the
 * conversation, the composer, and the management panels, plus the labels for the host's settings
 * catalogue, whose ids and tokens this module turns into prose. Product copy lives in the client
 * the way the TUI's selectors keep their own, so the host publishes data and the presentation
 * publishes words.
 *
 * `en` is the source of truth: `zh` is typed as a complete record of its keys, so a missing
 * translation is a compile error. The identity maps (settings fields, groups, options, scopes)
 * cannot be checked that way, so `strings.test.ts` and the coding-agent's catalogue test assert
 * that both languages carry the same identities.
 */
import { type Locale, documentLanguage } from "./locale.ts";

/** Message keys for the page's own copy: flat, dotted, and complete in both languages. */
export const EN = {
	"nav.chat": "Chat",
	"nav.plugins": "Plugins",
	"nav.skills": "Skills",
	"nav.settings": "Settings",

	"sidebar.newSession": "New session",
	"sidebar.sessions": "Sessions",
	"sidebar.management": "Management",
	"sidebar.waiting": "Waiting for the host…",

	"header.noSession": "No session",
	"header.back": "Back to the conversation",
	"header.noSessionAttached": "No session attached.",
	"header.noEntries": "No entries in this session yet.",
	"header.rosterEmpty": "No sessions on this host yet.",
	"header.connecting": "Connecting to the host…",

	"connection.starting": "starting…",
	"connection.connecting": "connecting…",
	"connection.connected": "connected · {id}",
	"connection.disconnected": "disconnected: {error}",
	"connection.hostGone": "host went away",

	"composer.placeholder": "Send a task to {id}",
	"composer.placeholderDetached": "No session attached",
	"composer.send": "Send",
	"composer.stop": "Stop",

	"model.none": "No model",
	"model.menuAria": "Model and reasoning effort",
	"model.chipAria": "Model and reasoning effort: {name}",
	"model.heading": "Model",
	"model.effort": "Effort",
	"model.empty": "No models available.",
	"model.levelsEmpty": "This model provides no reasoning effort levels.",

	"block.you": "You",
	"block.thinking": "Thinking",
	"block.compaction": "Compaction",
	"block.newContext": "New context",
	"block.truncated": "Truncated",
	"block.truncatedText": "Response was truncated before completion.",
	"block.aborted": "Aborted",
	"block.abortedText": "Operation aborted",
	"block.error": "Error",
	"block.errorText": "Unknown error",
	"tool.noOutput": "(no output)",
	"tool.errorText": "Tool reported an error",
	"tool.notRun": "Not run: the answer was interrupted.",

	"queue.steer": "steer",
	"queue.followUp": "follow-up",
	"queue.write": "write",

	"status.retrying": "Retrying (attempt {attempt}): {error}",
	"status.deferred": "Waiting for deferred response…",
	"status.compactingRetry": "Retrying {reason} compaction (attempt {attempt})…",
	"status.compacting": "Compacting ({reason})…",
	"status.runningTool": "Running {name}…",
	"status.working": "Working…",

	"panel.unavailable": "The host did not offer this service.",
	"panel.empty": "Nothing here yet.",
	"panel.cancel": "Cancel",
	"panel.dismiss": "Close",

	"panel.settings.title": "Settings",
	"panel.settings.description":
		"The agent's settings: provider behaviour, reasoning, tools, and the shell.",
	"panel.settings.filesTitle": "Files",
	"panel.settings.filesDescription": "Where the values above are read from and written to.",
	"panel.settings.reload": "Re-read files",
	"panel.settings.globalPath": "Global settings",
	"panel.settings.projectPath": "Project settings",
	"panel.settings.untrusted": "The project is not trusted, so its settings are not read.",
	"panel.settings.footnote":
		"A write goes to the global settings file. Other processes pick it up at their next start.",
	"panel.settings.notice": "{scope} settings ({path}): {message}",
	"panel.settings.noticePlain": "{scope} settings: {message}",
	"panel.settings.badgeDefault": "default",
	"panel.settings.invalidNumber": "Enter a whole number of at least {min}.",

	"panel.skills.title": "Skills",
	"panel.skills.description":
		"One folder per skill, each with a SKILL.md that carries a name and a description.",
	"panel.skills.loaded": "Loaded skills",
	"panel.skills.new": "New skill",
	"panel.skills.import": "Import…",
	"panel.skills.edit": "Edit",
	"panel.skills.view": "View",
	"panel.skills.remove": "Remove",
	"panel.skills.commandOnly": "command only",
	"panel.skills.empty":
		"No skills yet. New skills live in the agent directory and load when a session starts.",
	"panel.skills.footnote":
		"New and edited skills are written to {directory}. The agent loads skills when a session starts, like the CLI.",

	"panel.plugins.title": "Plugins",
	"panel.plugins.description":
		"Plugin packages the host builds, and the MCP servers the coding agent's tools read.",
	"panel.plugins.packages": "Plugin packages",
	"panel.plugins.packagesDescription":
		"A package is built into the Session's facet generation when a worker starts.",
	"panel.plugins.addPackage": "Add package…",
	"panel.plugins.packagesEmpty": "No plugin packages: sessions load the built-in facets only.",
	"panel.plugins.packagesFootnote":
		"The server default applies to sessions opened after the change. A running session keeps the generation it started with.",
	"panel.plugins.mcp": "MCP servers",
	"panel.plugins.mcpDescription": "Servers the coding agent's MCP extension connects, from mcp.json.",
	"panel.plugins.addServer": "Add server…",
	"panel.plugins.remove": "Remove",
	"panel.plugins.mcpEmpty": "No MCP servers configured in {path}.",
	"panel.plugins.mcpFootnote":
		"These entries are read by the CLI and the TUI; the experimental web host does not connect MCP servers yet.",
	"panel.plugins.fromExtension": "From extension",

	"modal.skillNew.title": "New skill",
	"modal.skillNew.description": "The description decides when the agent loads the skill.",
	"modal.skillNew.name": "Name",
	"modal.skillNew.namePlaceholder": "weekly-report",
	"modal.skillNew.descriptionLabel": "Description",
	"modal.skillNew.descriptionPlaceholder": "When to use this skill",
	"modal.skillNew.body": "Instructions",
	"modal.create": "Create",
	"modal.skillEdit.title": "Edit {name}",
	"modal.skillEdit.description":
		"The whole SKILL.md. The frontmatter must keep the skill's name and a description.",
	"modal.skillView.description":
		"This skill lives outside the agent directory, so it is read-only here.",
	"modal.skillFile": "SKILL.md",
	"modal.save": "Save",
	"modal.close": "Close",
	"modal.skillRemove.title": "Remove {name}?",
	"modal.skillRemove.description": "The skill's folder is deleted from the agent directory.",
	"modal.import.title": "Import a skill",
	"modal.import.description":
		"Copies a skill folder or markdown file into the agent's skills directory.",
	"modal.import.path": "Path",
	"modal.import.pathPlaceholder": "~/skills/weekly-report",
	"modal.import.submit": "Import",
	"modal.package.title": "Add a plugin package",
	"modal.package.description":
		"An absolute path to a package with src/session.ts, built when a session starts.",
	"modal.package.path": "Package path",
	"modal.package.pathPlaceholder": "/path/to/plugin",
	"modal.add": "Add",
	"modal.mcp.title": "Add an MCP server",
	"modal.mcp.description": "The server entry as JSON: a command for stdio, or a url for HTTP.",
	"modal.mcp.name": "Name",
	"modal.mcp.namePlaceholder": "filesystem",
	"modal.mcp.entry": "Entry",

	"page.cannotBoot": "cannot boot: {error}",
	"page.noManifest": "the host served this document without its boot manifest",
	"page.attachFailed": "attach failed: {error}",
	"page.newSessionFailed": "new session failed: {error}",
	"page.modelChangeFailed": "model change failed: {error}",
	"page.thinkingFailed": "thinking level failed: {error}",
	"page.sendFailed": "send failed: {error}",
	"page.abortFailed": "abort failed: {error}",
	"page.promptRejected": "prompt rejected: {error}",
	"page.panelFailed": "panel action failed: {error}",
	"page.streamFailed": "stream error: {error}",
	"page.modelStateFailed": "model state failed: {error}",
	"page.skillNeedsName": "a skill needs a name",
	"page.packageNeedsPath": "a plugin package needs a path",
} as const;

export type MessageKey = keyof typeof EN;

export const ZH: Readonly<Record<MessageKey, string>> = {
	"nav.chat": "对话",
	"nav.plugins": "插件",
	"nav.skills": "技能",
	"nav.settings": "设置",

	"sidebar.newSession": "新建会话",
	"sidebar.sessions": "会话",
	"sidebar.management": "管理",
	"sidebar.waiting": "正在等待宿主…",

	"header.noSession": "无会话",
	"header.back": "返回对话",
	"header.noSessionAttached": "尚未附加会话。",
	"header.noEntries": "这个会话还没有内容。",
	"header.rosterEmpty": "这台宿主上还没有会话。",
	"header.connecting": "正在连接宿主…",

	"connection.starting": "启动中…",
	"connection.connecting": "连接中…",
	"connection.connected": "已连接 · {id}",
	"connection.disconnected": "连接断开：{error}",
	"connection.hostGone": "宿主已退出",

	"composer.placeholder": "给 {id} 发送任务",
	"composer.placeholderDetached": "尚未附加会话",
	"composer.send": "发送",
	"composer.stop": "停止",

	"model.none": "无模型",
	"model.menuAria": "模型与推理强度",
	"model.chipAria": "模型与推理强度：{name}",
	"model.heading": "模型",
	"model.effort": "推理强度",
	"model.empty": "没有可用模型。",
	"model.levelsEmpty": "该模型不提供推理强度档位。",

	"block.you": "你",
	"block.thinking": "思考",
	"block.compaction": "上下文压缩",
	"block.newContext": "新上下文",
	"block.truncated": "已截断",
	"block.truncatedText": "回答在完成前被截断。",
	"block.aborted": "已中止",
	"block.abortedText": "操作已中止",
	"block.error": "错误",
	"block.errorText": "未知错误",
	"tool.noOutput": "（无输出）",
	"tool.errorText": "工具报错",
	"tool.notRun": "未执行：回答被中断。",

	"queue.steer": "介入",
	"queue.followUp": "后续",
	"queue.write": "写入",

	"status.retrying": "重试中（第 {attempt} 次）：{error}",
	"status.deferred": "等待延迟响应…",
	"status.compactingRetry": "重试{reason}压缩（第 {attempt} 次）…",
	"status.compacting": "压缩中（{reason}）…",
	"status.runningTool": "正在运行 {name}…",
	"status.working": "处理中…",

	"panel.unavailable": "宿主未提供该服务。",
	"panel.empty": "这里暂时没有内容。",
	"panel.cancel": "取消",
	"panel.dismiss": "关闭",

	"panel.settings.title": "设置",
	"panel.settings.description": "智能体的设置：供应商行为、推理、工具与 shell。",
	"panel.settings.filesTitle": "文件",
	"panel.settings.filesDescription": "以上取值的读写位置。",
	"panel.settings.reload": "重新读取文件",
	"panel.settings.globalPath": "全局设置",
	"panel.settings.projectPath": "项目设置",
	"panel.settings.untrusted": "项目未受信任，因此不读取其设置。",
	"panel.settings.footnote": "写入落到全局设置文件，其他进程在下次启动时读取。",
	"panel.settings.notice": "{scope}设置（{path}）：{message}",
	"panel.settings.noticePlain": "{scope}设置：{message}",
	"panel.settings.badgeDefault": "默认",
	"panel.settings.invalidNumber": "请输入不小于 {min} 的整数。",

	"panel.skills.title": "技能",
	"panel.skills.description": "每个技能一个目录，目录里的 SKILL.md 带有名称和描述。",
	"panel.skills.loaded": "已加载技能",
	"panel.skills.new": "新建技能",
	"panel.skills.import": "导入…",
	"panel.skills.edit": "编辑",
	"panel.skills.view": "查看",
	"panel.skills.remove": "删除",
	"panel.skills.commandOnly": "仅命令",
	"panel.skills.empty": "还没有技能。新技能放在智能体目录里，会话启动时加载。",
	"panel.skills.footnote": "新建和编辑的技能写入 {directory}。与 CLI 一样，智能体在会话启动时加载技能。",

	"panel.plugins.title": "插件",
	"panel.plugins.description": "宿主构建的插件包，以及编码智能体工具读取的 MCP 服务。",
	"panel.plugins.packages": "插件包",
	"panel.plugins.packagesDescription": "工作进程启动时，插件包会被构建进会话的 facet 代际。",
	"panel.plugins.addPackage": "添加插件包…",
	"panel.plugins.packagesEmpty": "还没有插件包：会话只加载内置 facet。",
	"panel.plugins.packagesFootnote": "服务端默认值作用于改动之后打开的会话；运行中的会话保留启动时的代际。",
	"panel.plugins.mcp": "MCP 服务",
	"panel.plugins.mcpDescription": "编码智能体的 MCP 扩展连接的服务器，来自 mcp.json。",
	"panel.plugins.addServer": "添加服务…",
	"panel.plugins.remove": "删除",
	"panel.plugins.mcpEmpty": "还没有在 {path} 中配置 MCP 服务。",
	"panel.plugins.mcpFootnote": "这些条目由 CLI 和 TUI 读取；实验性 web 宿主尚未连接 MCP 服务。",
	"panel.plugins.fromExtension": "来自扩展",

	"modal.skillNew.title": "新建技能",
	"modal.skillNew.description": "描述决定智能体何时加载这个技能。",
	"modal.skillNew.name": "名称",
	"modal.skillNew.namePlaceholder": "weekly-report",
	"modal.skillNew.descriptionLabel": "描述",
	"modal.skillNew.descriptionPlaceholder": "何时使用这个技能",
	"modal.skillNew.body": "指令",
	"modal.create": "创建",
	"modal.skillEdit.title": "编辑 {name}",
	"modal.skillEdit.description": "完整的 SKILL.md。前置元数据必须保留技能名称和描述。",
	"modal.skillView.description": "这个技能位于智能体目录之外，这里只读。",
	"modal.skillFile": "SKILL.md",
	"modal.save": "保存",
	"modal.close": "关闭",
	"modal.skillRemove.title": "删除 {name}？",
	"modal.skillRemove.description": "这个技能的目录会从智能体目录中删除。",
	"modal.import.title": "导入技能",
	"modal.import.description": "把技能目录或 Markdown 文件复制到智能体的技能目录。",
	"modal.import.path": "路径",
	"modal.import.pathPlaceholder": "~/skills/weekly-report",
	"modal.import.submit": "导入",
	"modal.package.title": "添加插件包",
	"modal.package.description": "插件包的绝对路径，包内要有 src/session.ts，会话启动时构建。",
	"modal.package.path": "插件包路径",
	"modal.package.pathPlaceholder": "/path/to/plugin",
	"modal.add": "添加",
	"modal.mcp.title": "添加 MCP 服务",
	"modal.mcp.description": "以 JSON 描述服务条目：stdio 用 command，HTTP 用 url。",
	"modal.mcp.name": "名称",
	"modal.mcp.namePlaceholder": "filesystem",
	"modal.mcp.entry": "条目",

	"page.cannotBoot": "无法启动：{error}",
	"page.noManifest": "宿主提供的文档缺少启动清单",
	"page.attachFailed": "附加失败：{error}",
	"page.newSessionFailed": "新建会话失败：{error}",
	"page.modelChangeFailed": "切换模型失败：{error}",
	"page.thinkingFailed": "切换推理强度失败：{error}",
	"page.sendFailed": "发送失败：{error}",
	"page.abortFailed": "中止失败：{error}",
	"page.promptRejected": "提示被拒绝：{error}",
	"page.panelFailed": "面板操作失败：{error}",
	"page.streamFailed": "流错误：{error}",
	"page.modelStateFailed": "读取模型状态失败：{error}",
	"page.skillNeedsName": "技能需要名称",
	"page.packageNeedsPath": "插件包需要路径",
};

/** One settings field's copy: the row's title, its one-line explanation, and a control placeholder. */
export interface SettingCopy {
	readonly label: string;
	readonly description: string;
	readonly placeholder?: string;
}

const EN_SETTING_GROUPS: Readonly<Record<string, string>> = {
	interface: "Interface",
	conversation: "Conversation",
	"models-reasoning": "Models & reasoning",
	"skills-tools": "Skills & tools",
	"network-retries": "Network & retries",
	"images-rendering": "Images & rendering",
	projects: "Projects",
	shell: "Shell",
};

const ZH_SETTING_GROUPS: Readonly<Record<string, string>> = {
	interface: "界面",
	conversation: "对话",
	"models-reasoning": "模型与推理",
	"skills-tools": "技能与工具",
	"network-retries": "网络与重试",
	"images-rendering": "图片与渲染",
	projects: "项目",
	shell: "Shell",
};

const EN_SETTING_FIELDS: Readonly<Record<string, SettingCopy>> = {
	locale: {
		label: "Language",
		description: "The interface language of the web page and other graphical surfaces.",
	},
	appearance: {
		label: "Appearance",
		description: "The palette the web page applies: the system's, or one fixed choice.",
	},
	compactionEnabled: {
		label: "Auto-compact",
		description: "Summarize the context when a conversation outgrows the model window.",
	},
	steeringMode: {
		label: "Steering mode",
		description: "How messages sent while a turn runs are applied.",
	},
	followUpMode: {
		label: "Follow-up mode",
		description: "How a message is queued when the turn would otherwise finish.",
	},
	hideThinkingBlock: {
		label: "Hide thinking blocks",
		description: "Fold the model's reasoning away wherever it is rendered.",
	},
	defaultThinkingLevel: {
		label: "Default thinking level",
		description: "The reasoning effort a conversation starts with.",
	},
	cacheWarming: {
		label: "Cache warming",
		description: "Pre-warm the prompt cache, which costs a call each time it runs.",
	},
	showCacheMissNotices: {
		label: "Cache miss notices",
		description: "Show the cost and provider recovery notices a cache miss produces.",
	},
	enableSkillCommands: {
		label: "Skills as commands",
		description: "Register every loaded skill as a slash command.",
	},
	transport: {
		label: "Transport",
		description: "How provider requests are carried.",
	},
	httpIdleTimeoutMs: {
		label: "HTTP idle timeout (ms)",
		description: "Header and body idle timeout for provider requests; 0 disables it.",
	},
	retryEnabled: {
		label: "Provider retries",
		description: "Retry a provider request that failed with a retryable error.",
	},
	imageAutoResize: {
		label: "Auto-resize images",
		description: "Scale attached images down for provider compatibility.",
	},
	blockImages: {
		label: "Block images",
		description: "Keep every image out of provider requests.",
	},
	mermaidRenderingMode: {
		label: "Mermaid diagrams",
		description: "When mermaid blocks in an answer are rendered as diagrams.",
	},
	defaultProjectTrust: {
		label: "Default project trust",
		description: "Whether a project's settings, extensions, and MCP servers load without being asked.",
	},
	quietStartup: {
		label: "Startup output",
		description: "How much the CLI prints when a session starts.",
	},
	shellPath: {
		label: "Shell path",
		description: "Shell used for the bash tool; empty uses the platform default.",
		placeholder: "System default",
	},
	shellCommandPrefix: {
		label: "Shell command prefix",
		description: "Prepended to every bash command, for example to enable aliases.",
		placeholder: "None",
	},
};

const ZH_SETTING_FIELDS: Readonly<Record<string, SettingCopy>> = {
	locale: {
		label: "界面语言",
		description: "网页及其他图形界面的语言。",
	},
	appearance: {
		label: "外观",
		description: "网页使用的配色：跟随系统，或固定为浅色、深色。",
	},
	compactionEnabled: {
		label: "自动压缩",
		description: "对话超出模型窗口时，压缩并总结上下文。",
	},
	steeringMode: {
		label: "介入方式",
		description: "回合运行中发送的消息如何应用。",
	},
	followUpMode: {
		label: "后续方式",
		description: "回合即将结束时的消息如何排队。",
	},
	hideThinkingBlock: {
		label: "隐藏思考块",
		description: "在所有呈现中折叠模型的推理内容。",
	},
	defaultThinkingLevel: {
		label: "默认推理强度",
		description: "对话启动时使用的推理强度。",
	},
	cacheWarming: {
		label: "缓存预热",
		description: "提前预热提示缓存，每次运行都会产生一次调用。",
	},
	showCacheMissNotices: {
		label: "缓存未命中提示",
		description: "显示缓存未命中产生的费用与供应商恢复提示。",
	},
	enableSkillCommands: {
		label: "技能作为命令",
		description: "把每个已加载的技能注册为斜杠命令。",
	},
	transport: {
		label: "传输方式",
		description: "供应商请求的承载方式。",
	},
	httpIdleTimeoutMs: {
		label: "HTTP 空闲超时（毫秒）",
		description: "供应商请求的头部与正文空闲超时；0 表示不超时。",
	},
	retryEnabled: {
		label: "供应商重试",
		description: "对可重试的失败请求再次发起请求。",
	},
	imageAutoResize: {
		label: "自动缩放图片",
		description: "把附带的图片缩小，以提升供应商兼容性。",
	},
	blockImages: {
		label: "拦截图片",
		description: "任何图片都不进入供应商请求。",
	},
	mermaidRenderingMode: {
		label: "Mermaid 图表",
		description: "回答中的 mermaid 代码块何时渲染成图表。",
	},
	defaultProjectTrust: {
		label: "默认项目信任",
		description: "项目的设置、扩展和 MCP 服务是否无需询问即可加载。",
	},
	quietStartup: {
		label: "启动输出",
		description: "会话启动时 CLI 打印多少内容。",
	},
	shellPath: {
		label: "Shell 路径",
		description: "bash 工具使用的 shell；留空使用平台默认值。",
		placeholder: "系统默认",
	},
	shellCommandPrefix: {
		label: "Shell 命令前缀",
		description: "附加在每个 bash 命令之前，例如用于启用别名。",
		placeholder: "无",
	},
};

/** An enum control's names, keyed by the field's catalogue id and then its stored value. */
const EN_SETTING_OPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	locale: { auto: "Browser default", zh: "中文", en: "English" },
	appearance: { system: "System", light: "Light", dark: "Dark" },
	steeringMode: { "one-at-a-time": "One at a time", all: "All at once" },
	followUpMode: { "one-at-a-time": "One at a time", all: "All at once" },
	cacheWarming: { off: "Off", streaming: "While streaming", idle: "Between runs too" },
	mermaidRenderingMode: { off: "Off", final: "Settled answers", streaming: "While streaming" },
	transport: { auto: "Auto", websocket: "WebSocket", sse: "SSE" },
	defaultProjectTrust: { ask: "Ask", always: "Always trust", never: "Never trust" },
	quietStartup: { false: "Show startup output", header: "Header only", true: "Hide startup output" },
};

const ZH_SETTING_OPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	locale: { auto: "跟随浏览器", zh: "中文", en: "English" },
	appearance: { system: "跟随系统", light: "浅色", dark: "深色" },
	steeringMode: { "one-at-a-time": "逐条应用", all: "全部应用" },
	followUpMode: { "one-at-a-time": "逐条排队", all: "全部排队" },
	cacheWarming: { off: "关闭", streaming: "流式过程中", idle: "回合之间也预热" },
	mermaidRenderingMode: { off: "关闭", final: "回答结束后", streaming: "流式过程中" },
	transport: { auto: "自动", websocket: "WebSocket", sse: "SSE" },
	defaultProjectTrust: { ask: "询问", always: "始终信任", never: "从不信任" },
	quietStartup: { false: "显示启动输出", header: "只显示标题", true: "隐藏启动输出" },
};

/** Reasoning effort names, shared by the settings control and the composer's effort picker. */
const EN_THINKING_LEVELS: Readonly<Record<string, string>> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
};

const ZH_THINKING_LEVELS: Readonly<Record<string, string>> = {
	off: "关闭",
	minimal: "极简",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "极高",
	max: "最高",
};

/** Where a settings error came from: the agent directory's file, or the checkout's overrides. */
const EN_SETTING_SCOPES: Readonly<Record<string, string>> = { global: "Global", project: "Project" };
const ZH_SETTING_SCOPES: Readonly<Record<string, string>> = { global: "全局", project: "项目" };

/** Which mcp.json an MCP server entry came from, or the extension that registered it. */
const EN_MCP_SCOPES: Readonly<Record<string, string>> = {
	global: "global",
	project: "project",
	extension: "extension",
};
const ZH_MCP_SCOPES: Readonly<Record<string, string>> = { global: "全局", project: "项目", extension: "扩展" };

/** The scopes the skill loader reports. */
const EN_SKILL_SCOPES: Readonly<Record<string, string>> = { user: "user", project: "project", temporary: "temporary" };
const ZH_SKILL_SCOPES: Readonly<Record<string, string>> = { user: "用户", project: "项目", temporary: "临时" };

/** How an MCP server entry is exposed to the model. */
const EN_MCP_EXPOSURES: Readonly<Record<string, string>> = {
	codemode: "Codemode",
	deferred: "Deferred",
	direct: "Direct",
	hidden: "Hidden",
};
const ZH_MCP_EXPOSURES: Readonly<Record<string, string>> = {
	codemode: "代码模式",
	deferred: "延迟",
	direct: "直接",
	hidden: "隐藏",
};

function clean(text: string, values: Record<string, string> | undefined): string {
	if (values === undefined) return text;
	return text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

/** One message in the reader's language, with `{name}` placeholders filled from `values`. */
export function translate(locale: Locale, key: MessageKey, values?: Record<string, string>): string {
	return clean((locale === "zh" ? ZH : EN)[key], values);
}

/**
 * A settings field's copy. The catalogue's id is the key; a field the dictionaries do not know
 * shows its id rather than an empty row, so a new host field is visible instead of invisible.
 */
export function settingFieldCopy(locale: Locale, id: string): SettingCopy {
	const table = locale === "zh" ? ZH_SETTING_FIELDS : EN_SETTING_FIELDS;
	return table[id] ?? { label: id, description: "" };
}

/** A settings heading's name; an unknown group token shows the token itself. */
export function settingGroupCopy(locale: Locale, group: string): string {
	const table = locale === "zh" ? ZH_SETTING_GROUPS : EN_SETTING_GROUPS;
	return table[group] ?? group;
}

/** An enum control's name for one stored value; an unknown value shows the value itself. */
export function settingOptionCopy(locale: Locale, id: string, value: string): string {
	const table = locale === "zh" ? ZH_SETTING_OPTIONS : EN_SETTING_OPTIONS;
	return table[id]?.[value] ?? value;
}

/** The settings error's scope name. */
export function settingScopeCopy(locale: Locale, scope: string): string {
	const table = locale === "zh" ? ZH_SETTING_SCOPES : EN_SETTING_SCOPES;
	return table[scope] ?? scope;
}

export function skillScopeCopy(locale: Locale, scope: string): string {
	const table = locale === "zh" ? ZH_SKILL_SCOPES : EN_SKILL_SCOPES;
	return table[scope] ?? scope;
}

export function mcpScopeCopy(locale: Locale, scope: string): string {
	const table = locale === "zh" ? ZH_MCP_SCOPES : EN_MCP_SCOPES;
	return table[scope] ?? scope;
}

export function mcpExposureCopy(locale: Locale, exposure: string): string {
	const table = locale === "zh" ? ZH_MCP_EXPOSURES : EN_MCP_EXPOSURES;
	return table[exposure] ?? exposure;
}

/** A reasoning effort's name; a level the dictionaries do not know is shown capitalized. */
export function thinkingLevelCopy(locale: Locale, level: string): string {
	const table = locale === "zh" ? ZH_THINKING_LEVELS : EN_THINKING_LEVELS;
	if (table[level] !== undefined) return table[level];
	return level.length === 0 ? level : `${level[0]?.toUpperCase() ?? ""}${level.slice(1)}`;
}

/**
 * The served document in one language: the `<html lang>` attribute and every `{{message.key}}`
 * marker of the static shell. The host localizes the document before it answers, so the first
 * paint is already in the reader's language instead of the bundle's English placeholders.
 */
export function localizeDocument(html: string, locale: Locale): string {
	const localized = html.replace(/\{\{([A-Za-z0-9._-]+)\}\}/g, (marker, key: string) => {
		if (!(key in EN)) return marker;
		return translate(locale, key as MessageKey);
	});
	return localized.replace(/<html lang="[^"]*"/, `<html lang="${documentLanguage(locale)}"`);
}

/** Every identity the dictionaries carry, for the coverage tests. */
export function copyIdentities(locale: Locale): {
	readonly messages: readonly string[];
	readonly settingGroups: readonly string[];
	readonly settingFields: readonly string[];
	readonly settingOptions: Readonly<Record<string, readonly string[]>>;
} {
	const fields = locale === "zh" ? ZH_SETTING_FIELDS : EN_SETTING_FIELDS;
	const options = locale === "zh" ? ZH_SETTING_OPTIONS : EN_SETTING_OPTIONS;
	return {
		messages: Object.keys(locale === "zh" ? ZH : EN),
		settingGroups: Object.keys(locale === "zh" ? ZH_SETTING_GROUPS : EN_SETTING_GROUPS),
		settingFields: Object.keys(fields),
		settingOptions: Object.fromEntries(Object.entries(options).map(([id, values]) => [id, Object.keys(values)])),
	};
}
