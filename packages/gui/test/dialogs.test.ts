import { describe, expect, test } from "vitest";
import {
	closeDialogCopy,
	HOST_DIALOG_TAIL_LINES,
	hostFailureCopy,
	isIntentionalLoadAbort,
	lifecycleErrorCopy,
	quitDialogCopy,
	renderDialogRecovery,
	renderFailureCopy,
	shouldPresentRenderFailure,
	visibleOutputTail,
} from "../src/dialogs.ts";

describe("render failure dialog", () => {
	test("assembles reload and quit for a crashed page", () => {
		const copy = renderFailureCopy("zh", { kind: "render-process-gone", reason: "crashed", exitCode: 11 });
		expect(copy.title).toBe("页面出错");
		expect(copy.message).toBe("页面进程已退出（崩溃，退出码 11）。");
		expect(copy.detail).toBe("");
		expect(copy.buttons).toEqual(["重新加载", "退出"]);
	});

	test("uses a neutral explanation for an unknown renderer reason", () => {
		const copy = renderFailureCopy("en", { kind: "render-process-gone", reason: "solar-flare", exitCode: 0 });
		expect(copy.message).toBe("The page process exited (unexpected exit, exit code 0).");
		expect(copy.buttons).toEqual(["Reload", "Quit"]);
	});

	test("names a main-frame load failure and keeps the URL as detail", () => {
		const copy = renderFailureCopy("zh", {
			kind: "did-fail-load",
			isMainFrame: true,
			errorCode: -105,
			errorDescription: "ERR_NAME_NOT_RESOLVED",
			validatedURL: "http://127.0.0.1:4310/",
		});
		expect(copy.title).toBe("页面加载失败");
		expect(copy.message).toBe("页面没有加载成功。无法识别服务地址，请检查地址配置");
		expect(copy.detail).toBe("http://127.0.0.1:4310/");
		expect(copy.buttons).toEqual(["重新加载", "退出"]);
	});

	test("a main-frame failure is presented, and an aborted or subframe load is not", () => {
		const crashed = { kind: "render-process-gone" as const, reason: "clean-exit", exitCode: 0 };
		expect(shouldPresentRenderFailure(false, crashed)).toBe(true);
		expect(shouldPresentRenderFailure(true, crashed)).toBe(false);
		expect(isIntentionalLoadAbort(-3, "ERR_ABORTED")).toBe(true);
		expect(isIntentionalLoadAbort(-105, "ERR_ABORTED")).toBe(true);
		expect(isIntentionalLoadAbort(-105, "ERR_NAME_NOT_RESOLVED")).toBe(false);

		const aborted = {
			kind: "did-fail-load" as const,
			isMainFrame: true,
			errorCode: -3,
			errorDescription: "ERR_ABORTED",
			validatedURL: "http://127.0.0.1:1/",
		};
		expect(shouldPresentRenderFailure(false, aborted)).toBe(false);
		const subframe = { ...aborted, isMainFrame: false, errorCode: -105, errorDescription: "ERR_FAILED" };
		expect(shouldPresentRenderFailure(false, subframe)).toBe(false);
		const failed = { ...aborted, errorCode: -105, errorDescription: "ERR_NAME_NOT_RESOLVED" };
		expect(shouldPresentRenderFailure(false, failed)).toBe(true);
		expect(shouldPresentRenderFailure(true, failed)).toBe(false);
	});

	test("reload loads the host address again", () => {
		const host = "http://127.0.0.1:4310/";
		expect(renderDialogRecovery(0, false, host)).toEqual({ kind: "load", url: host });
		expect(renderDialogRecovery(0, true, host)).toEqual({ kind: "quit" });
		expect(renderDialogRecovery(1, false, host)).toEqual({ kind: "quit" });
		expect(renderDialogRecovery(0, false, undefined)).toEqual({ kind: "quit" });
		expect(renderDialogRecovery(0, false, "")).toEqual({ kind: "quit" });
	});
});

describe("task close and quit dialogs", () => {
	test("close offers background first, stop-and-quit second, cancel last, and an unchecked-by-default remember label", () => {
		const copy = closeDialogCopy("zh");
		expect(copy.title).toBe("仍有任务正在运行");
		expect(copy.detail).toBe("关闭窗口后，任务可以继续在后台运行。你也可以停止任务并退出 AmazMe。");
		expect(copy.buttons).toEqual(["继续后台运行", "停止任务并退出", "取消"]);
		expect(copy.checkboxLabel).toBe("记住我的选择");
	});

	test("explicit quit has no background or remember action", () => {
		const copy = quitDialogCopy("zh");
		expect(copy.title).toBe("仍有任务正在运行");
		expect(copy.buttons).toEqual(["取消", "停止任务并退出"]);
		expect(copy.detail).toContain("取消不会改变");
		expect(copy).not.toHaveProperty("checkboxLabel");
	});

	test("query and cleanup failures offer a retry without claiming success", () => {
		expect(lifecycleErrorCopy("zh", "activity").buttons).toEqual(["重试", "稍后"]);
		const cleanup = lifecycleErrorCopy("zh", "cleanup");
		expect(cleanup.title).toBe("退出清理未完成");
		expect(cleanup.detail).toContain("没有退出");
		expect(cleanup.buttons).toEqual(["重试退出", "稍后"]);
	});
});

describe("host failure dialog", () => {
	test("includes the exit code, signal, and trailing output", () => {
		const lines = Array.from({ length: HOST_DIALOG_TAIL_LINES + 3 }, (_, index) => `line ${String(index)}`);
		const copy = hostFailureCopy("zh", {
			kind: "unexpected-exit",
			code: 1,
			signal: "SIGTERM",
			tail: lines.join("\n"),
		});
		expect(copy.title).toBe("宿主已退出");
		expect(copy.message).toBe("网页宿主意外退出了（退出码 1，信号 SIGTERM）。");
		expect(copy.buttons).toEqual(["退出"]);
		expect(copy.detail.split("\n").slice(1)).toEqual(lines.slice(-HOST_DIALOG_TAIL_LINES));
		expect(copy.detail.startsWith("...\n")).toBe(true);
	});

	test("says when the host produced no output and when the code is missing", () => {
		const copy = hostFailureCopy("en", {
			kind: "exit-before-ready",
			message: "desktop host exited before readiness (code null, signal null)",
			code: null,
			signal: null,
			tail: "   \n",
		});
		expect(copy.title).toBe("Host failed to start");
		expect(copy.message).toBe("The web host exited before it was ready (exit code none, signal none).");
		expect(copy.detail).toBe("(no output)");
	});

	test.each(["en", "zh"] as const)("localizes structured failures and keeps raw diagnostics in detail (%s)", (locale) => {
		const spawn = hostFailureCopy(locale, { kind: "spawn-error", message: "desktop host failed to spawn: ENOENT", tail: "missing node\n" });
		expect(spawn.message).toBe(locale === "zh" ? "无法启动网页宿主。" : "Could not start the web host.");
		expect(spawn.detail).toContain("ENOENT");
		expect(spawn.detail).toContain("missing node");
		const timeout = hostFailureCopy(locale, {
			kind: "readiness-timeout", timeoutMs: 60_000,
			message: "desktop host readiness timed out after 60000ms", tail: "",
		});
		expect(timeout.message).toBe(locale === "zh" ? "网页宿主没有在 60000 毫秒内就绪。" : "The web host was not ready within 60000 ms.");
		expect(timeout.detail).toContain("readiness timed out after 60000ms");
		for (const kind of ["startup-error", "invalid-output"] as const) {
			const invalid = hostFailureCopy(locale, { kind, message: "desktop host entry is missing: cli.ts", tail: "" });
			expect(invalid.message).toBe(locale === "zh" ? "网页宿主启动失败。" : "The web host failed while starting.");
			expect(invalid.detail).toContain("desktop host entry is missing: cli.ts");
		}
	});

	test("visibleOutputTail drops a carriage return and a too-long line", () => {
		expect(visibleOutputTail("a\r\nb\r")).toBe("a\nb");
		expect(visibleOutputTail("")).toBe("");
		const huge = "y".repeat(5_000);
		expect(visibleOutputTail(huge).startsWith("...\n")).toBe(true);
		expect(visibleOutputTail(huge).endsWith("y")).toBe(true);
	});
});
