/**
 * Copy for the shell's own chrome: the edit menu and the failure dialogs.
 *
 * `en` is the source of truth. `zh` is a complete record of its keys, so a missing translation
 * is a compile error. The page has its own catalog; this one is only what the shell draws
 * outside the page. Call sites ask `translate` for a key. They do not embed either language.
 */
import { type Locale } from "./locale.ts";

/** Message keys for the shell's own copy: flat, dotted, and complete in both languages. */
export const EN = {
	"menu.undo": "Undo",
	"menu.redo": "Redo",
	"menu.cut": "Cut",
	"menu.copy": "Copy",
	"menu.paste": "Paste",
	"menu.selectAll": "Select All",

	"dialog.reload": "Reload",
	"dialog.quit": "Quit",

	"render.gone.title": "Page error",
	"render.gone.message": "The page process exited ({reason}, exit code {exitCode}).",
	"render.load.title": "Page failed to load",
	"render.load.message": "The page did not load ({errorCode} {errorDescription}).",
	"render.reason.clean-exit": "clean exit",
	"render.reason.abnormal-exit": "abnormal exit",
	"render.reason.killed": "killed",
	"render.reason.crashed": "crashed",
	"render.reason.oom": "out of memory",
	"render.reason.launch-failed": "launch failed",
	"render.reason.integrity-failure": "integrity failure",
	"render.reason.memory-eviction": "memory eviction",

	"host.spawn.title": "Host failed to start",
	"host.spawn.message": "Could not start the web host: {message}",
	"host.early.title": "Host failed to start",
	"host.early.message": "The web host exited before it was ready (exit code {code}, signal {signal}).",
	"host.timeout.title": "Host failed to start",
	"host.timeout.message": "The web host was not ready in time: {message}",
	"host.invalid.title": "Host failed to start",
	"host.invalid.message": "The web host failed while starting: {message}",
	"host.crashed.title": "Host exited",
	"host.crashed.message": "The web host exited unexpectedly (exit code {code}, signal {signal}).",
	"host.none": "none",
	"host.noOutput": "(no output)",
} as const;

export type MessageKey = keyof typeof EN;

const ZH: Record<MessageKey, string> = {
	"menu.undo": "撤销",
	"menu.redo": "重做",
	"menu.cut": "剪切",
	"menu.copy": "复制",
	"menu.paste": "粘贴",
	"menu.selectAll": "全选",

	"dialog.reload": "重新加载",
	"dialog.quit": "退出",

	"render.gone.title": "页面出错",
	"render.gone.message": "页面进程已退出（{reason}，退出码 {exitCode}）。",
	"render.load.title": "页面加载失败",
	"render.load.message": "页面没有加载成功（{errorCode} {errorDescription}）。",
	"render.reason.clean-exit": "正常退出",
	"render.reason.abnormal-exit": "异常退出",
	"render.reason.killed": "被终止",
	"render.reason.crashed": "崩溃",
	"render.reason.oom": "内存不足",
	"render.reason.launch-failed": "启动失败",
	"render.reason.integrity-failure": "完整性校验失败",
	"render.reason.memory-eviction": "内存被回收",

	"host.spawn.title": "宿主启动失败",
	"host.spawn.message": "无法启动网页宿主：{message}",
	"host.early.title": "宿主启动失败",
	"host.early.message": "网页宿主尚未就绪就退出了（退出码 {code}，信号 {signal}）。",
	"host.timeout.title": "宿主启动失败",
	"host.timeout.message": "网页宿主没有在时限内就绪：{message}",
	"host.invalid.title": "宿主启动失败",
	"host.invalid.message": "网页宿主启动失败：{message}",
	"host.crashed.title": "宿主已退出",
	"host.crashed.message": "网页宿主意外退出了（退出码 {code}，信号 {signal}）。",
	"host.none": "无",
	"host.noOutput": "（无输出）",
};

function fill(text: string, values: Record<string, string> | undefined): string {
	if (values === undefined) return text;
	return text.replace(/\{(\w+)\}/gu, (match, name: string) => values[name] ?? match);
}

/** One shell message in the reader's language, with `{name}` placeholders filled from `values`. */
export function translate(locale: Locale, key: MessageKey, values?: Record<string, string>): string {
	return fill((locale === "zh" ? ZH : EN)[key], values);
}
