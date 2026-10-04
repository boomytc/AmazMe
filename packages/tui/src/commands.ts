import type { RemoteLane } from "@amazme/runtime-service/client";

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
  { name: "login", hint: "提供方", description: "保存 OAuth 凭证", takesArgs: "required" },
  { name: "logout", hint: "提供方", description: "删除凭证", takesArgs: "required" },
  { name: "steer", hint: "文本", description: "插入当前操作", takesArgs: "required" },
  { name: "abort", hint: "", description: "中止当前操作", takesArgs: "none" },
  { name: "continue", hint: "", description: "继续已写下的重试等待", takesArgs: "none" },
  { name: "earlier", hint: "", description: "再读一页更早的条目", takesArgs: "none" },
  { name: "quit", hint: "", description: "离开全屏；页面和附着端不停止宿主", takesArgs: "none" },
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

const HOTKEYS = [
  "Enter 提交",
  "Ctrl-C 忙则中止，有输入则清空",
  "Ctrl-D 空闲且输入为空时离开全屏",
  "Esc 在输入和滚动之间切换",
  "滚动时 ↑↓ 移动条目，PgUp/PgDn 移动轮次，i 回到输入",
].join("\n");

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
  | { type: "login"; provider: string }
  | { type: "logout"; provider: string }
  | { type: "session" };

export type SlashAction = Exclude<SlashCommand, { type: "prompt" } | { type: "notice" }>;

export type SlashOutcome =
  | { type: "none" }
  | { type: "notice"; text: string }
  | { type: "quit" };

export interface SlashActions {
  lane(): RemoteLane;
  list(): Promise<readonly string[]>;
  active(): string;
  open(name: string): Promise<void>;
  earlier(): Promise<string>;
  continueRetry(): Promise<string>;
  login?(provider: string): Promise<string>;
  logout?(provider: string): Promise<string>;
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
  const name = ALIAS[head.slice(1)];
  if (!name) return notice(`未知命令 ${head}。输入 /help 查看命令。`);
  switch (name) {
    case "help":
      return rest ? usage("/help") : notice(HELP);
    case "hotkeys":
      return rest ? usage("/hotkeys") : notice(HOTKEYS);
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
      return providerArg(rest, "/login 提供方", "login");
    case "logout":
      return providerArg(rest, "/logout 提供方", "logout");
    case "session":
      return rest ? usage("/session") : { type: "session" };
    default:
      return notice(`未知命令 ${head}。输入 /help 查看命令。`);
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
        await actions.lane().fork(name, snap.tipId);
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
        if (!actions.login) return notice("当前客户端不能登录");
        return notice(await actions.login(command.provider));
      }
      case "logout": {
        if (!actions.logout) return notice("当前客户端不能退出登录");
        return notice(await actions.logout(command.provider));
      }
      case "session": {
        const current = await actions.lane().configure();
        return notice(`会话 ${actions.active()} 模型 ${current.provider}/${current.modelId} 思考 ${current.thinkingLevel}`);
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
  session: "session",
  "session-info": "session",
  status: "session",
  info: "session",
};

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
