import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, dialog, ipcMain } from "electron";
import type { Locale } from "@amazme/web/locale";
import { translate } from "@amazme/web/strings";
import type { UpdateChannel } from "@amazme/coding-agent/update-manifest";
import { createUpdateController, type DesktopUpdateIO, type UpdateState } from "./update-controller.ts";
import { createMacUpdateIO } from "./macos-update.ts";

export function updateWindowCopy(locale: Locale, state: UpdateState): Record<string, string> {
	const t = (key: Parameters<typeof translate>[1], values?: Record<string, string>): string => translate(locale, key, values);
	const copy: Record<string, string> = { language: locale };
	for (const key of ["heading", "channelLabel", "automaticLabel", "trust", "check", "download", "cancel", "later", "stable", "preview"] as const) copy[key] = t(`desktop.update.${key}`);
	copy.install = t("desktop.update.installAction");
	copy.current = t("desktop.update.current", { version: state.current });
	copy.status = t(`desktop.update.${state.phase}`, { version: state.version ?? "", percent: state.total ? String(Math.floor((state.received ?? 0) / state.total * 100)) : "0" });
	copy.error = state.error ? t(`desktop.update.${state.error}`) : "";
	copy.detail = state.phase === "ready" ? t("desktop.update.readyDetail") : state.channel === "preview" ? t("desktop.update.previewDetail") : state.phase === "available" ? t("desktop.update.availableDetail") : "";
	return copy;
}

export function createDesktopUpdates(options: {
	readonly version: string;
	readonly executable: string;
	readonly userData: string;
	readonly locale: () => Promise<Locale>;
	readonly confirmQuit: () => Promise<boolean>;
	readonly prepareHost?: () => Promise<boolean>;
	readonly resumeHost?: () => Promise<void>;
	readonly quit: () => Promise<void>;
	/** Tests substitute IO, never a production trust bypass or arbitrary feed URL. */
	readonly io?: DesktopUpdateIO;
}) {
	let window: BrowserWindow | undefined;
	let automatic = true;
	let channel: UpdateChannel = "stable";
	let checkedAt = 0;
	let disposed = false;
	let poll: ReturnType<typeof setInterval> | undefined;
	let prompting = false;
	const preferences = join(options.userData, "updates", "preferences.json");
	const url = new URL("./update-window.html", import.meta.url).href;
	const io = options.io ?? createMacUpdateIO({ target: dirname(dirname(dirname(options.executable))), current: options.version, arch: process.arch,
		cache: join(options.userData, "updates", "cache"), userData: options.userData, confirmQuit: options.confirmQuit,
		prepareHost: options.prepareHost, quit: options.quit, resumeHost: options.resumeHost });
	const publish = async (): Promise<void> => {
		const current = window;
		if (!current || current.isDestroyed()) return;
		const locale = await options.locale();
		if (!current.isDestroyed()) current.webContents.send("amazme:update-state", { ...controller.state(), channel, automatic }, updateWindowCopy(locale, controller.state()));
	};
	const controller = createUpdateController(options.version, io, state => {
		if (state.phase === "available") void show();
		void publish();
	});
	const save = async (): Promise<void> => {
		try {
			await mkdir(dirname(preferences), { recursive: true, mode: 0o700 });
			await writeFile(`${preferences}.tmp`, JSON.stringify({ automatic, channel, checkedAt }), { mode: 0o600 });
			await rename(`${preferences}.tmp`, preferences);
		} catch { /* Preferences are optional; installation integrity is independent. */ }
	};
	async function show(): Promise<void> {
		if (disposed) return;
		if (window && !window.isDestroyed()) { window.show(); window.focus(); await publish(); return; }
		const created = new BrowserWindow({ width: 600, height: 550, resizable: false, title: "AmazMe", show: false,
			webPreferences: { preload: fileURLToPath(new URL("./update-preload.cjs", import.meta.url)), sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true } });
		window = created;
		created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		created.webContents.on("will-navigate", event => event.preventDefault());
		created.on("close", event => { if (controller.state().phase === "installing") event.preventDefault(); });
		created.on("closed", () => { if (window === created) window = undefined; });
		await created.loadURL(url);
		if (!created.isDestroyed()) { await publish(); created.show(); }
	}
	async function check(): Promise<void> { checkedAt = Date.now(); await save(); await controller.check(channel); }
	const handler: Parameters<typeof ipcMain.handle>[1] = async (event, command: unknown, value: unknown) => {
		if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || window.webContents.getURL() !== url || disposed || prompting) return;
		if (command === "state") return publish();
		if (command === "later") { if (controller.state().phase !== "installing") window.hide(); return; }
		if (command === "cancel") { controller.cancel(); return; }
		if (command === "check") return check();
		if (["checking", "downloading", "verifying", "ready", "installing"].includes(controller.state().phase)) {
			if (command === "install" && controller.state().phase === "ready") return controller.install();
			return;
		}
		if (command === "channel" && (value === "stable" || value === "preview")) { channel = value; await save(); return check(); }
		if (command === "automatic" && typeof value === "boolean") { automatic = value; await save(); return publish(); }
		if (command === "download") {
			prompting = true;
			try {
			const locale = await options.locale();
			const result = await dialog.showMessageBox(window, { type: "question", message: translate(locale, "desktop.update.downloadConfirm", { version: controller.state().version ?? "" }),
				buttons: [translate(locale, "desktop.update.later"), translate(locale, "desktop.update.download")], defaultId: 0, cancelId: 0, noLink: true });
			if (result.response === 1) return controller.download();
			} finally { prompting = false; }
		}
	};
	ipcMain.handle("amazme:update-command", handler);
	return {
		show,
		async start(): Promise<void> {
			try {
				const value = JSON.parse(await readFile(preferences, "utf8")) as Record<string, unknown>;
				automatic = value.automatic !== false; channel = value.channel === "preview" ? "preview" : "stable";
				checkedAt = typeof value.checkedAt === "number" && Number.isFinite(value.checkedAt) ? value.checkedAt : 0;
			} catch { /* First launch checks automatically. */ }
			const automaticCheck = (): void => { if (automatic && !disposed && (Date.now() < checkedAt || Date.now() - checkedAt >= 86_400_000) && !["ready", "installing"].includes(controller.state().phase)) void check(); };
			automaticCheck(); poll = setInterval(automaticCheck, 60_000); poll.unref();
		},
		async dispose(): Promise<void> { disposed = true; clearInterval(poll); ipcMain.removeHandler("amazme:update-command"); window?.destroy(); await controller.dispose(); },
	};
}
