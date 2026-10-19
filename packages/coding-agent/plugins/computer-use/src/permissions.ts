import type { CallToolResult } from "@amazme/mcp";
import { isRecord } from "./config.ts";
import { driverEnvironment } from "./driver.ts";
import { runPermissionPanel } from "./permission-panel.ts";

const labels = {
	accessibility: "辅助功能（设备控制和数据访问）",
	screen_recording: "屏幕录制（录屏与系统录音）",
} as const;
export type PermissionKind = keyof typeof labels;
export type PermissionStatus = {
	status: "ready" | "permission_required" | "unknown";
	missing: PermissionKind[];
	message: string;
	host_path?: string;
	driver_path?: string;
};

export function permissionStatus(response: CallToolResult): PermissionStatus {
	const data = response.structuredContent;
	if (
		!isRecord(data) ||
		typeof data.accessibility !== "boolean" ||
		typeof data.screen_recording !== "boolean"
	)
		return {
			status: "unknown",
			missing: [],
			message:
				"当前运行时未返回可识别的桌面权限状态，请检查该驱动的权限诊断及宿主机桌面会话。本次操作未继续。",
		};
	const missing = (Object.keys(labels) as PermissionKind[]).filter(
		(key) => !data[key],
	);
	const host_path =
		typeof data.host_path === "string" ? data.host_path : undefined;
	const driver_path =
		typeof data.driver_path === "string" ? data.driver_path : undefined;
	return {
		status: missing.length ? "permission_required" : "ready",
		missing,
		host_path,
		driver_path,
		message: missing.length
			? `Computer-use 需要：${missing.map((key) => labels[key]).join("、")}。\n\n请在运行 AmazMe 的宿主机打开“系统设置 → 隐私与安全性”，为实际运行时应用开启以上权限。${host_path ? `\n授权应用：${host_path}\n如果列表中没有它，用“＋”添加此应用；不要误选终端或旧版本。` : "\n请核对实际驱动的应用或启动终端。"}\n\n授权后运行 /computer-use setup 重新检查。若系统要求退出并重新打开应用，请按系统提示操作。权限就绪后需重新观察，再发起新的操作；本次动作不会自动重发。`
			: `Computer-use 权限已就绪。${host_path ? `\n授权应用：${host_path}\n` : ""}请重新观察目标窗口，再发起新的操作；不会自动重发之前的动作。`,
	};
}

export class PermissionRequiredError extends Error {
	readonly report: PermissionStatus;
	constructor(report: PermissionStatus) {
		super(report.message);
		this.report = report;
	}
}

export interface PermissionDialog {
	run(
		report: PermissionStatus,
		read: (signal: AbortSignal) => Promise<PermissionStatus>,
		signal: AbortSignal,
	): Promise<void>;
}
export const nativePermissionDialog: PermissionDialog = {
	run: (report, read, signal) =>
		runPermissionPanel(report, read, signal, driverEnvironment()),
};

/** A guide has its own lifetime: it never holds an action open or resumes it. */
export class PermissionGuide {
	private pending?: { controller: AbortController; done: Promise<void> };
	private readonly shown = new Set<string>();
	private closed = false;
	private readonly dialog: PermissionDialog;
	private readonly platform: string;
	constructor(
		dialog: PermissionDialog = nativePermissionDialog,
		platform: string = process.platform,
	) {
		this.dialog = dialog;
		this.platform = platform;
	}

	ready(report: PermissionStatus): void {
		if (report.status === "ready" && report.host_path)
			this.shown.delete(report.host_path);
	}

	offer(
		report: PermissionStatus,
		read: (signal: AbortSignal) => Promise<PermissionStatus>,
		force = false,
	): void {
		const path = report.host_path;
		if (
			this.closed ||
			this.pending ||
			this.platform !== "darwin" ||
			report.status === "unknown" ||
			(report.status === "ready" && !force) ||
			!path?.endsWith(".app") ||
			!report.driver_path?.startsWith(`${path}/Contents/MacOS/`) ||
			(!force && this.shown.has(path))
		)
			return;
		if (report.status === "permission_required") this.shown.add(path);
		const controller = new AbortController();
		const pending = { controller, done: Promise.resolve() };
		this.pending = pending;
		pending.done = this.dialog
			.run(
				report,
				async (signal) => {
					const next = await read(signal);
					this.ready(next);
					return next;
				},
				controller.signal,
			)
			.catch(() => {
				// Headless/unavailable UI must not bypass the gate. The tool/command
				// still carries the full instructions and setup can explicitly reopen it.
			})
			.finally(() => {
				if (this.pending === pending) this.pending = undefined;
			});
	}

	async dismiss(): Promise<void> {
		const pending = this.pending;
		pending?.controller.abort();
		await pending?.done;
	}
	async dispose(): Promise<void> {
		this.closed = true;
		await this.dismiss();
	}
}
