import { describe, expect, test } from "vitest";
import {
	HOST_DIALOG_TAIL_LINES,
	hostFailureCopy,
	isIntentionalLoadAbort,
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

	test("keeps an unknown renderer reason as the raw token", () => {
		const copy = renderFailureCopy("en", { kind: "render-process-gone", reason: "solar-flare", exitCode: 0 });
		expect(copy.message).toBe("The page process exited (solar-flare, exit code 0).");
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
		expect(copy.message).toBe("页面没有加载成功（-105 ERR_NAME_NOT_RESOLVED）。");
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

	test("spawn, timeout, and invalid launch each keep their own sentence and the tail", () => {
		expect(
			hostFailureCopy("zh", { kind: "spawn-error", message: "desktop host failed to spawn: missing", tail: "err\n" }),
		).toMatchObject({
			title: "宿主启动失败",
			message: "无法启动网页宿主：desktop host failed to spawn: missing",
			detail: "err",
			buttons: ["退出"],
		});
		expect(
			hostFailureCopy("zh", {
				kind: "readiness-timeout",
				message: "desktop host readiness timed out after 60000ms",
				tail: "",
			}).message,
		).toBe("网页宿主没有在时限内就绪：desktop host readiness timed out after 60000ms");
		expect(hostFailureCopy("en", { kind: "startup-error", message: "desktop host entry is missing: cli.ts", tail: "" })).toMatchObject({
			message: "The web host failed while starting: desktop host entry is missing: cli.ts",
			detail: "(no output)",
		});
	});

	test("visibleOutputTail drops a carriage return and a too-long line", () => {
		expect(visibleOutputTail("a\r\nb\r")).toBe("a\nb");
		expect(visibleOutputTail("")).toBe("");
		const huge = "y".repeat(5_000);
		expect(visibleOutputTail(huge).startsWith("...\n")).toBe(true);
		expect(visibleOutputTail(huge).endsWith("y")).toBe(true);
	});
});
