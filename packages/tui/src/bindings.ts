import type { Key } from "./keys.ts";
import type { TuiState } from "./reduce.ts";

/**
 * 快捷键只有这一份。浮层、底栏提示和 `/hotkeys` 都从这里取文案；
 * `reduce` 用同一个 id 执行。改行为就改这一行，说明会跟着变。
 */
export interface Binding {
  id: string;
  key: Key["type"];
  /** Set when only one character of `key: "char"` is this binding. */
  char?: string;
  label: string;
  /** Short phrase on the persistent hint row. */
  help: string;
  /** Sentence in the overlay and `/hotkeys`. */
  detail: string;
  hint: boolean;
  catalog: boolean;
  when: (state: TuiState) => boolean;
}

function prompting(state: TuiState): boolean {
  return !state.overlay && state.picker === null && state.focus === "prompt";
}

function scrolling(state: TuiState): boolean {
  return !state.overlay && state.picker === null && state.focus === "scroll";
}

function bind<const I extends string>(entry: Binding & { id: I }): Binding & { id: I } {
  return entry;
}

export const BINDINGS = [
  bind({
    id: "submit",
    key: "enter",
    label: "Enter",
    help: "发送",
    detail: "发送",
    hint: false,
    catalog: true,
    when: prompting,
  }),
  bind({
    id: "newline",
    key: "newline",
    label: "Shift+Enter/Alt+Enter",
    help: "换行",
    detail: "换行。终端分不出 Shift+Enter 时用 Alt+Enter",
    hint: true,
    catalog: true,
    when: prompting,
  }),
  bind({
    id: "prompt-up",
    key: "up",
    label: "↑",
    help: "上一条",
    detail: "斜杠菜单里上移；否则移到上一行；在第一行翻到上一条",
    hint: false,
    catalog: true,
    when: prompting,
  }),
  bind({
    id: "prompt-down",
    key: "down",
    label: "↓",
    help: "下一条",
    detail: "斜杠菜单里下移；否则移到下一行；在最后一行翻到下一条",
    hint: false,
    catalog: true,
    when: prompting,
  }),
  bind({
    id: "cursor-left",
    key: "left",
    label: "←",
    help: "左移",
    detail: "向左移动光标",
    hint: false,
    catalog: true,
    when: prompting,
  }),
  bind({
    id: "cursor-right",
    key: "right",
    label: "→",
    help: "右移",
    detail: "向右移动光标",
    hint: false,
    catalog: true,
    when: prompting,
  }),
  bind({
    id: "backspace",
    key: "backspace",
    label: "Backspace",
    help: "删除",
    detail: "删除光标前的字符",
    hint: false,
    catalog: true,
    when: prompting,
  }),
  bind({
    id: "complete",
    key: "tab",
    label: "Tab",
    help: "补全",
    detail: "补全斜杠命令",
    hint: false,
    catalog: true,
    when: prompting,
  }),
  bind({
    id: "dismiss",
    key: "escape",
    label: "Esc",
    help: "关闭",
    detail: "关闭快捷键浮层，否则在输入和滚动之间切换",
    hint: false,
    catalog: true,
    when: (state) => state.picker === null,
  }),
  bind({
    id: "overlay",
    key: "char",
    char: "?",
    label: "?",
    help: "快捷键",
    detail: "输入为空时打开快捷键",
    hint: true,
    catalog: true,
    when: (state) => prompting(state) && state.input.length === 0,
  }),
  bind({
    id: "interrupt",
    key: "ctrl-c",
    label: "Ctrl-C",
    help: "退出",
    detail: "忙则中止，有输入则清空，空闲时再按一次退出",
    hint: true,
    catalog: true,
    when: prompting,
  }),
  bind({
    id: "leave",
    key: "ctrl-d",
    label: "Ctrl-D",
    help: "离开全屏",
    detail: "空闲且输入为空时离开全屏",
    hint: false,
    catalog: true,
    when: (state) => state.picker === null && !state.busy && state.input.length === 0,
  }),
  bind({
    id: "scroll-up",
    key: "up",
    label: "↑",
    help: "上一条目",
    detail: "滚动时移到上一条目",
    hint: false,
    catalog: true,
    when: scrolling,
  }),
  bind({
    id: "scroll-down",
    key: "down",
    label: "↓",
    help: "下一条目",
    detail: "滚动时移到下一条目",
    hint: false,
    catalog: true,
    when: scrolling,
  }),
  bind({
    id: "scroll-page-up",
    key: "page-up",
    label: "PgUp",
    help: "上一轮",
    detail: "滚动时移到上一轮",
    hint: false,
    catalog: true,
    when: scrolling,
  }),
  bind({
    id: "scroll-page-down",
    key: "page-down",
    label: "PgDn",
    help: "下一轮",
    detail: "滚动时移到下一轮",
    hint: false,
    catalog: true,
    when: scrolling,
  }),
  bind({
    id: "scroll-edit",
    key: "char",
    char: "i",
    label: "i",
    help: "回到输入",
    detail: "滚动时回到输入",
    hint: false,
    catalog: true,
    when: scrolling,
  }),
  bind({
    id: "toggle-tool",
    key: "ctrl-o",
    label: "Ctrl-O",
    help: "工具详情",
    detail: "展开或收起最近一张工具卡片，最多 20 行",
    hint: false,
    catalog: true,
    when: (state) => state.picker === null && !state.overlay,
  }),
  bind({
    id: "cycle-model",
    key: "ctrl-p",
    label: "Ctrl-P",
    help: "下一个模型",
    detail: "切到模型循环里的下一个模型",
    hint: false,
    catalog: true,
    when: prompting,
  }),
  bind({
    id: "copy-reply",
    key: "ctrl-y",
    label: "Ctrl-Y",
    help: "复制",
    detail: "复制最后一条助手回复",
    hint: false,
    catalog: true,
    when: (state) => state.picker === null,
  }),
  bind({
    id: "insert",
    key: "char",
    label: "",
    help: "",
    detail: "",
    hint: false,
    catalog: false,
    when: prompting,
  }),
];

export type BindingId = (typeof BINDINGS)[number]["id"];

export function activeBinding(state: TuiState, key: Key): (typeof BINDINGS)[number] | undefined {
  return BINDINGS.find((binding) => {
    if (binding.key !== key.type) return false;
    if (binding.char !== undefined && (key.type !== "char" || key.value !== binding.char)) return false;
    return binding.when(state);
  });
}

/** Persistent row under the status line. */
export function composerHint(): string {
  return BINDINGS.filter((binding) => binding.hint).map((binding) => `${binding.label} ${binding.help}`).join("  ");
}

/** Overlay and `/hotkeys` share this text. */
export function hotkeyText(): string {
  return BINDINGS.filter((binding) => binding.catalog).map((binding) => `${binding.label}  ${binding.detail}`).join("\n");
}
