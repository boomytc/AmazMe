import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { RemoteLane } from "@amazme/runtime-service/client";
import { hotkeyText } from "./bindings.ts";
import {
  activateProject,
  cycleModels,
  displayName,
  exportBody,
  externalCommand,
  extraKind,
  grantTrust,
  parseImportedMessages,
  readProject,
  readSetting,
  runExtension,
  saveScopedModel,
  saveSetting,
  scopedModels,
  setDisplayName,
  templateText,
} from "./project.ts";

const THINKING = ["off", "minimal", "low", "medium", "high"] as const;
export type SlashThinking = (typeof THINKING)[number];

const LANE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SlashListing {
  name: string;
  hint: string;
  description: string;
  takesArgs: "none" | "optional" | "required";
}

/** Commands the composer menu can offer. Aliases stay in the parser and are not separate rows. */
export const SLASH_LIST: readonly SlashListing[] = [
  { name: "help", hint: "", description: "列出命令", takesArgs: "none" },
  { name: "hotkeys", hint: "", description: "列出按键", takesArgs: "none" },
  { name: "new", hint: "", description: "新对话", takesArgs: "none" },
  { name: "resume", hint: "名称", description: "换对话；不带名称则列出", takesArgs: "optional" },
  { name: "fork", hint: "名称", description: "从当前进度分出对话", takesArgs: "required" },
  { name: "clone", hint: "", description: "分出并打开", takesArgs: "none" },
  { name: "rewind", hint: "", description: "退到上一轮用户消息之前", takesArgs: "none" },
  { name: "compact", hint: "", description: "压缩当前上下文", takesArgs: "none" },
  { name: "session", hint: "", description: "显示模型和思考级别", takesArgs: "none" },
  { name: "model", hint: "提供方/模型", description: "切换模型；不带参数则显示", takesArgs: "optional" },
  { name: "thinking", hint: "级别", description: "设置思考级别；不带参数则显示", takesArgs: "optional" },
  { name: "login", hint: "提供方", description: "选择供应商并登录；不带参数则打开列表", takesArgs: "optional" },
  { name: "logout", hint: "提供方", description: "选择供应商并删除凭证", takesArgs: "optional" },
  { name: "steer", hint: "文本", description: "插入当前操作", takesArgs: "required" },
  { name: "abort", hint: "", description: "中止当前操作", takesArgs: "none" },
  { name: "continue", hint: "", description: "继续已写下的重试等待", takesArgs: "none" },
  { name: "earlier", hint: "", description: "再读一页更早的条目", takesArgs: "none" },
  { name: "quit", hint: "", description: "离开全屏；页面和附着端不停止宿主", takesArgs: "none" },
  { name: "web", hint: "", description: "在当前宿主上打开网页", takesArgs: "none" },
  { name: "gui", hint: "", description: "在当前宿主上打开图形窗口", takesArgs: "none" },
  { name: "name", hint: "名称", description: "设置会话显示名", takesArgs: "optional" },
  { name: "tree", hint: "", description: "在当前会话里选择条目", takesArgs: "none" },
  { name: "import", hint: "路径", description: "导入 JSONL 会话", takesArgs: "required" },
  { name: "export", hint: "路径", description: "导出 HTML 或 JSONL", takesArgs: "optional" },
  { name: "reload", hint: "", description: "重新加载技能、模板和扩展", takesArgs: "none" },
  { name: "settings", hint: "键 值", description: "读写工作区设置", takesArgs: "optional" },
  { name: "scoped-models", hint: "提供方/模型", description: "限制模型循环", takesArgs: "optional" },
  { name: "trust", hint: "", description: "信任当前项目并加载资源", takesArgs: "none" },
  { name: "share", hint: "", description: "分享会话；未配置则失败", takesArgs: "none" },
  { name: "bug", hint: "", description: "报告问题；未配置则失败", takesArgs: "none" },
  { name: "llama", hint: "", description: "管理 llama；未配置则失败", takesArgs: "none" },
];

const HELP = SLASH_LIST.map((item) => `/${item.name}${item.hint ? ` ${item.hint}` : ""} ${item.description}`).join("\n");

/** Rows for a composer that is still choosing a command. Arguments hide the menu. */
export function slashMatches(input: string): SlashListing[] {
  const text = input.trimStart();
  if (!text.startsWith("/")) return [];
  const token = text.slice(1);
  if (/\s/.test(token)) return [];
  const query = token.toLowerCase();
  return SLASH_LIST.filter((item) => query.length === 0 || item.name.includes(query));
}

export type SlashCommand =
  | { type: "prompt"; text: string }
  | { type: "notice"; text: string }
  | { type: "quit" }
  | { type: "new-session" }
  | { type: "resume"; name?: string }
  | { type: "compact" }
  | { type: "fork"; name: string }
  | { type: "clone" }
  | { type: "rewind" }
  | { type: "abort" }
  | { type: "steer"; text: string }
  | { type: "continue" }
  | { type: "earlier" }
  | { type: "model"; provider?: string; modelId?: string }
  | { type: "thinking"; level?: SlashThinking }
  | { type: "login"; provider?: string }
  | { type: "logout"; provider?: string }
  | { type: "web" }
  | { type: "gui" }
  | { type: "session" }
  | { type: "name"; value?: string }
  | { type: "tree"; entryId?: string }
  | { type: "import"; path: string }
  | { type: "export"; path?: string }
  | { type: "reload" }
  | { type: "settings"; key?: string; value?: string }
  | { type: "scoped-models"; spec?: string }
  | { type: "trust" }
  | { type: "external"; name: "share" | "bug" | "llama" }
  | { type: "template"; name: string; rest: string }
  | { type: "extension"; name: string; rest: string };

export type SlashAction = Exclude<SlashCommand, { type: "prompt" } | { type: "notice" }>;

export type SlashOutcome =
  | { type: "none" }
  | { type: "notice"; text: string }
  | { type: "quit" }
  | { type: "submit"; text: string };

export interface SlashActions {
  lane(): RemoteLane;
  list(): Promise<readonly string[]>;
  active(): string;
  open(name: string): Promise<void>;
  earlier(): Promise<string>;
  continueRetry(): Promise<string>;
  login?(provider: string): Promise<string>;
  logout?(provider: string): Promise<string>;
  /** Open the loopback page on the host this client already uses. */
  openWeb?(): Promise<string>;
  /** Open a graphical window on the host this client already uses. */
  openGui?(): Promise<string>;
  cwd?: string;
}

/** One durable drive. A waiting outcome continues through the stored `notBefore`; a settled drive is not sent again. */
export async function finishDrive(lane: RemoteLane, operationId: string): Promise<void> {
  const outcome = await lane.drive(operationId, { waitForRetry: true });
  if (outcome.kind === "waiting") await lane.drive(outcome.operationId, { waitForRetry: true });
}

/** A line that starts with `/` is a command. Anything else is a prompt. Unknown commands are not prompts. */
export function parseSlash(input: string): SlashCommand {
  const text = input.trim();
  if (!text.startsWith("/")) return { type: "prompt", text };
  const space = text.search(/\s/);
  const head = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : text.slice(space + 1).trim();
  const rawName = head.slice(1);
  const aliased = ALIAS[rawName];
  if (!aliased) {
    const extra = extraKind(rawName);
    if (extra === "template") return { type: "template", name: rawName, rest };
    if (extra === "command") return { type: "extension", name: rawName, rest };
    return notice(`未知命令 ${head}。输入 /help 查看命令。`);
  }
  const name = aliased;
  switch (name) {
    case "help":
      return rest ? usage("/help") : notice(HELP);
    case "hotkeys":
      return rest ? usage("/hotkeys") : notice(hotkeyText());
    case "quit":
      return rest ? usage("/quit") : { type: "quit" };
    case "new":
      return rest ? usage("/new") : { type: "new-session" };
    case "resume": {
      if (!rest) return { type: "resume" };
      const lane = laneName(rest);
      return lane ? { type: "resume", name: lane } : notice("会话名称无效");
    }
    case "compact":
      return rest ? usage("/compact") : { type: "compact" };
    case "fork": {
      if (!rest) return usage("/fork 名称");
      const lane = laneName(rest);
      return lane ? { type: "fork", name: lane } : notice("会话名称无效");
    }
    case "clone":
      return rest ? usage("/clone") : { type: "clone" };
    case "rewind":
      return rest ? usage("/rewind") : { type: "rewind" };
    case "abort":
      return rest ? usage("/abort") : { type: "abort" };
    case "steer":
      return rest ? { type: "steer", text: rest } : usage("/steer 文本");
    case "continue":
      return rest ? usage("/continue") : { type: "continue" };
    case "earlier":
      return rest ? usage("/earlier") : { type: "earlier" };
    case "model":
      return parseModel(rest);
    case "thinking":
      return parseThinking(rest);
    case "login":
      return rest ? providerArg(rest, "/login 提供方", "login") : { type: "login" };
    case "logout":
      return rest ? providerArg(rest, "/logout 提供方", "logout") : { type: "logout" };
    case "web":
      return rest ? usage("/web") : { type: "web" };
    case "gui":
      return rest ? usage("/gui") : { type: "gui" };
    case "session":
      return rest ? usage("/session") : { type: "session" };
    case "name":
      return { type: "name", ...(rest ? { value: rest } : {}) };
    case "tree":
      return rest ? { type: "tree", entryId: rest } : { type: "tree" };
    case "import":
      return rest ? { type: "import", path: rest } : usage("/import 路径");
    case "export":
      return { type: "export", ...(rest ? { path: rest } : {}) };
    case "reload":
      return rest ? usage("/reload") : { type: "reload" };
    case "settings":
      return parseSettings(rest);
    case "scoped-models":
      return { type: "scoped-models", ...(rest ? { spec: rest } : {}) };
    case "trust":
      return rest ? usage("/trust") : { type: "trust" };
    case "share":
    case "bug":
    case "llama":
      return rest ? usage(`/${name}`) : { type: "external", name };
    default: {
      const extra = extraKind(name);
      if (extra === "template") return { type: "template", name, rest };
      if (extra === "command") return { type: "extension", name, rest };
      return notice(`未知命令 ${head}。输入 /help 查看命令。`);
    }
  }
}

export function nextSessionName(sessions: readonly string[]): string {
  const used = new Set(sessions);
  let index = used.size + 1;
  let name = `s${index}`;
  while (used.has(name)) {
    index += 1;
    name = `s${index}`;
  }
  return name;
}

/** Run a parsed command against the attached lane. Prompt text is not handled here. */
export async function executeSlash(command: SlashAction, actions: SlashActions): Promise<SlashOutcome> {
  try {
    switch (command.type) {
      case "quit":
        return { type: "quit" };
      case "new-session": {
        const name = nextSessionName(await actions.list());
        await actions.open(name);
        return notice(`会话 ${name}`);
      }
      case "resume": {
        if (!command.name) return notice(`会话：${(await actions.list()).join(" ")}`);
        await actions.open(command.name);
        return notice(`会话 ${command.name}`);
      }
      case "compact": {
        const admitted = await actions.lane().accept({ kind: "compaction" });
        await finishDrive(actions.lane(), admitted.operationId);
        return notice("已压缩");
      }
      case "fork":
      case "clone": {
        const name = command.type === "clone" ? nextSessionName(await actions.list()) : command.name;
        const snap = await actions.lane().snapshot();
        const entryId = command.type === "clone" ? snap.tipId : latestUserEntry(snap.entries) ?? snap.tipId;
        await actions.lane().fork(name, entryId);
        await actions.open(name);
        return notice(`会话 ${name}`);
      }
      case "rewind": {
        const snap = await actions.lane().snapshot();
        let target: string | null | undefined;
        for (let index = snap.entries.length - 1; index >= 0; index -= 1) {
          const entry = snap.entries[index];
          if (entry?.payload.type === "message" && entry.payload.message.role === "user") {
            target = entry.parentId;
            break;
          }
        }
        if (target === undefined) return notice("没有可回退的回合");
        const admitted = await actions.lane().accept({ kind: "navigation", targetId: target });
        await finishDrive(actions.lane(), admitted.operationId);
        return notice("已回退到上一轮之前");
      }
      case "abort": {
        const snap = await actions.lane().snapshot();
        if (!snap.operationId) return notice("没有进行中的操作");
        await actions.lane().requestAbort(snap.operationId);
        return notice("已请求中止");
      }
      case "steer":
        await actions.lane().steer(command.text);
        return notice("已插入");
      case "continue":
        return notice(await actions.continueRetry());
      case "earlier":
        return notice(await actions.earlier());
      case "model": {
        if (!command.provider || !command.modelId) {
          const current = await actions.lane().configure();
          return notice(`模型 ${current.provider}/${current.modelId}。用法：/model 提供方/模型`);
        }
        const next = await actions.lane().configure({ provider: command.provider, modelId: command.modelId });
        return notice(`模型 ${next.provider}/${next.modelId} 思考 ${next.thinkingLevel}`);
      }
      case "thinking": {
        if (!command.level) {
          const current = await actions.lane().configure();
          return notice(`思考 ${current.thinkingLevel}。可用 ${current.thinkingLevels.join(" ")}`);
        }
        const next = await actions.lane().configure({ thinkingLevel: command.level });
        return notice(`思考 ${next.thinkingLevel}`);
      }
      case "login": {
        if (!command.provider) return notice("用法：/login 提供方");
        if (!actions.login) return notice("当前客户端不能登录");
        return notice(await actions.login(command.provider));
      }
      case "logout": {
        if (!command.provider) return notice("用法：/logout 提供方");
        if (!actions.logout) return notice("当前客户端不能退出登录");
        return notice(await actions.logout(command.provider));
      }
      case "web":
        return actions.openWeb ? notice(await actions.openWeb()) : notice("当前客户端不能打开网页");
      case "gui":
        return actions.openGui ? notice(await actions.openGui()) : notice("当前客户端不能打开图形窗口");
      case "session": {
        const current = await actions.lane().configure();
        const named = actions.cwd ? displayName(actions.cwd, actions.active()) : "";
        const label = named ? `${actions.active()} ${named}` : actions.active();
        return notice(`会话 ${label} 模型 ${current.provider}/${current.modelId} 思考 ${current.thinkingLevel}`);
      }
      case "name": {
        if (!actions.cwd) return notice("当前客户端没有工作区");
        if (!command.value) return notice(`名称 ${displayName(actions.cwd, actions.active()) || "未命名"}`);
        setDisplayName(actions.cwd, actions.active(), command.value);
        return notice(`名称 ${command.value}`);
      }
      case "tree": {
        if (!command.entryId) {
          const snap = await actions.lane().snapshot();
          const lines = snap.entries.map((entry) => entryLine(entry)).filter((line) => line.length > 0);
          return notice(lines.join("\n") || "没有条目");
        }
        const admitted = await actions.lane().accept({ kind: "navigation", targetId: command.entryId });
        await finishDrive(actions.lane(), admitted.operationId);
        return notice("已切换分支");
      }
      case "import": {
        if (!actions.cwd) return notice("当前客户端没有工作区");
        const messages = parseImportedMessages(readFileSync(resolvePath(actions.cwd, command.path), "utf8"));
        if (messages.length === 0) return notice("导入文件没有消息");
        const name = nextSessionName(await actions.list());
        await actions.lane().importMessages(name, messages);
        await actions.open(name);
        return notice(`会话 ${name}`);
      }
      case "export": {
        if (!actions.cwd) return notice("当前客户端没有工作区");
        const target = command.path ?? "session.html";
        const format = target.endsWith(".jsonl") ? "jsonl" : "html";
        const snap = await actions.lane().snapshot();
        const entries = snap.entries.map((entry) => transcriptLine(entry)).filter((entry): entry is { role: string; text: string } => entry !== null);
        const file = resolvePath(actions.cwd, target);
        writeFileSync(file, exportBody(entries, format));
        return notice(`已导出 ${file}`);
      }
      case "reload": {
        if (!actions.cwd) return notice("当前客户端没有工作区");
        return notice(await activateProject(actions.cwd));
      }
      case "settings": {
        if (!actions.cwd) return notice("当前客户端没有工作区");
        if (!command.key) {
          const rows = Object.entries(readProject(actions.cwd).settings).map(([key, value]) => `${key}=${value}`);
          return notice(rows.join("\n") || "没有设置");
        }
        if (command.value === undefined) return notice(readSetting(actions.cwd, command.key) ?? "未设置");
        return notice(saveSetting(actions.cwd, command.key, command.value));
      }
      case "scoped-models": {
        if (!actions.cwd) return notice("当前客户端没有工作区");
        if (!command.spec) {
          const enabled = scopedModels(actions.cwd);
          const current = await actions.lane().configure();
          const next = cycleModels(enabled, `${current.provider}/${current.modelId}`);
          return notice(enabled.length === 0 ? "模型循环未限制" : `模型循环 ${enabled.join(" ")} 下一个 ${next}`);
        }
        if (!command.spec.includes("/")) return notice("用法：/scoped-models 提供方/模型");
        return notice(`模型循环 ${saveScopedModel(actions.cwd, command.spec)}`);
      }
      case "trust": {
        if (!actions.cwd) return notice("当前客户端没有工作区");
        const text = grantTrust(actions.cwd);
        await activateProject(actions.cwd);
        return notice(text);
      }
      case "external":
        return actions.cwd ? notice(externalCommand(actions.cwd, command.name)) : notice(`${command.name} 未配置外部服务`);
      case "template": {
        const text = templateText(command.name, command.rest);
        return text === null ? notice(`未知命令 /${command.name}。输入 /help 查看命令。`) : { type: "submit", text };
      }
      case "extension": {
        const text = await runExtension(command.name, command.rest);
        return text === null ? notice(`未知命令 /${command.name}。输入 /help 查看命令。`) : notice(text);
      }
      default:
        return command satisfies never;
    }
  } catch (error) {
    return notice(error instanceof Error ? error.message : String(error));
  }
}

const ALIAS: Record<string, string> = {
  help: "help",
  hotkeys: "hotkeys",
  quit: "quit",
  exit: "quit",
  new: "new",
  clear: "new",
  resume: "resume",
  compact: "compact",
  fork: "fork",
  clone: "clone",
  rewind: "rewind",
  undo: "rewind",
  abort: "abort",
  steer: "steer",
  continue: "continue",
  earlier: "earlier",
  model: "model",
  m: "model",
  thinking: "thinking",
  effort: "thinking",
  login: "login",
  logout: "logout",
  web: "web",
  gui: "gui",
  session: "session",
  "session-info": "session",
  status: "session",
  info: "session",
  name: "name",
  tree: "tree",
  import: "import",
  export: "export",
  reload: "reload",
  settings: "settings",
  "scoped-models": "scoped-models",
  trust: "trust",
  share: "share",
  bug: "bug",
  llama: "llama",
};

function parseSettings(rest: string): SlashCommand {
  if (!rest) return { type: "settings" };
  const space = rest.indexOf(" ");
  if (space === -1) return { type: "settings", key: rest };
  return { type: "settings", key: rest.slice(0, space), value: rest.slice(space + 1) };
}

function resolvePath(cwd: string, target: string): string {
  return isAbsolute(target) ? target : resolve(cwd, target);
}

function latestUserEntry(entries: readonly { id: string; payload: { type: string; message?: { role?: string } } }[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.payload.type === "message" && entry.payload.message?.role === "user") return entry.id;
  }
  return null;
}

function entryLine(entry: { id: string; payload: { type: string; summary?: string; message?: { role?: string; content?: unknown } } }): string {
  const line = transcriptLine(entry);
  if (!line) return "";
  return `${entry.id} ${line.role} ${line.text}`;
}

function transcriptLine(entry: { payload: { type: string; summary?: string; message?: { role?: string; content?: unknown } } }): { role: string; text: string } | null {
  if (entry.payload.type === "compaction") return { role: "compaction", text: entry.payload.summary ?? "" };
  const message = entry.payload.message;
  if (!message?.role) return null;
  const text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((block) => block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "").join("")
      : "";
  return { role: message.role, text };
}

function notice(text: string): { type: "notice"; text: string } {
  return { type: "notice", text };
}

function usage(text: string): SlashCommand {
  return notice(`用法：${text}`);
}

function laneName(value: string): string | null {
  if (value.length < 1 || value.length > 64 || !LANE.test(value) || /\s/.test(value)) return null;
  return value;
}

function providerArg(rest: string, hint: string, type: "login" | "logout"): SlashCommand {
  if (!rest || /\s/.test(rest)) return usage(hint);
  return { type, provider: rest };
}

function parseModel(rest: string): SlashCommand {
  if (!rest) return { type: "model" };
  if (/\s/.test(rest) && rest.includes("/")) return usage("/model 提供方/模型");
  if (rest.includes("/")) {
    const slash = rest.indexOf("/");
    const provider = rest.slice(0, slash);
    const modelId = rest.slice(slash + 1);
    if (!provider || !modelId || provider.length > 128 || modelId.length > 256) return usage("/model 提供方/模型");
    return { type: "model", provider, modelId };
  }
  const parts = rest.split(/\s+/);
  const provider = parts[0] ?? "";
  const modelId = parts.slice(1).join(" ");
  if (!provider || !modelId || provider.length > 128 || modelId.length > 256) return usage("/model 提供方/模型");
  return { type: "model", provider, modelId };
}

function parseThinking(rest: string): SlashCommand {
  if (!rest) return { type: "thinking" };
  const level = rest.toLowerCase();
  if (!THINKING.includes(level as SlashThinking) || /\s/.test(rest)) {
    return notice(`未知思考级别。可用 ${THINKING.join(" ")}`);
  }
  return { type: "thinking", level: level as SlashThinking };
}
