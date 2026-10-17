import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_DIRECTORY } from "@amazme/web/assets";
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	nativeImage,
	shell,
	Tray,
	type Event as ElectronEvent,
	type MessageBoxOptions,
} from "electron";
import { desktopLocale, readDesktopDocumentLanguage, readDesktopLocalePreference } from "./locale.ts";
import { hostFailureCopy, quitDialogCopy, renderDialogRecovery, renderFailureCopy, type HostFailure, type RenderFailure } from "./dialogs.ts";
import { createHostSupervisor, spawnWebHost, type HostStartupFailure, type HostSupervisor } from "./host.ts";
import {
	hostWorkingDirectory,
	missingHostEntry,
	resolveHostCli,
	resolveNodeExecutable,
	webHostLaunch,
} from "./launch.ts";
import { applicationMenuTemplate, editMenuTemplate } from "./menu.ts";
import { isAllowedNavigation, isExternalUrl } from "./navigation.ts";
import { createShellController, type ShellController } from "./shell.ts";
import { attentionOnTitle } from "./title.ts";
import { trayMenuTemplate } from "./tray.ts";
import { translate } from "@amazme/web/strings";

const APP_NAME = "AmazMe";
const APP_ICON = join(PAGE_DIRECTORY, "app-icon.png");
const TRAY_ICON = fileURLToPath(new URL("../assets/tray-icon.png", import.meta.url));
app.setName(APP_NAME);
const SMOKE = process.env.AMAZME_GUI_SMOKE === "1";
if (SMOKE && process.env.AMAZME_GUI_SMOKE_DATA_DIR) app.setPath("userData", process.env.AMAZME_GUI_SMOKE_DATA_DIR);

const SMOKE_EXPRESSION = `({
	title: document.title,
	boot: globalThis.__AMAZME_BOOT__ != null && typeof globalThis.__AMAZME_BOOT__ === "object",
	name: globalThis.__AMAZME_BOOT__ && globalThis.__AMAZME_BOOT__.app && globalThis.__AMAZME_BOOT__.app.name,
	version: globalThis.__AMAZME_BOOT__ && globalThis.__AMAZME_BOOT__.app && globalThis.__AMAZME_BOOT__.app.version,
	mode: globalThis.__AMAZME_BOOT__ && globalThis.__AMAZME_BOOT__.mode,
	serverId: globalThis.__AMAZME_BOOT__ && globalThis.__AMAZME_BOOT__.server && globalThis.__AMAZME_BOOT__.server.id,
	language: document.documentElement.lang,
	transport: globalThis.__AMAZME_BOOT__ && globalThis.__AMAZME_BOOT__.transport && globalThis.__AMAZME_BOOT__.transport.url
})`;

let host: HostSupervisor | undefined;
let hostPageUrl: string | undefined;
let window: BrowserWindow | undefined;
let rendererReady = false;
let shutdownPromise: Promise<void> | undefined;
let quitReleased = false;
let quitRequested = false;
let showingDialog = false;
let deferredHost: HostFailure | undefined;
let startupFailure: HostStartupFailure | undefined;
let folderPicker: Promise<readonly string[]> | undefined;
let tray: Tray | undefined;
let quitPrompt: Promise<boolean> | undefined;
let notices: ShellController;

function readinessTimeout(): number | undefined {
	const raw = process.env.AMAZME_GUI_READY_TIMEOUT_MS;
	if (raw === undefined || raw.length === 0) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function shutdownHost(): Promise<void> {
	shutdownPromise ??= host?.shutdown() ?? Promise.resolve();
	return shutdownPromise;
}

async function currentLocale() {
	const preferred = app.getPreferredSystemLanguages();
	const system = app.getLocale();
	const languages = preferred.length > 0 ? preferred : system.length > 0 ? [system] : [];
	const preference = await readDesktopLocalePreference(hostWorkingDirectory(process.env, process.cwd()), process.env);
	const current = liveWindow();
	let documentLanguage: unknown;
	// Constant read from the owned page, not a new renderer capability or arbitrary IPC execution.
	if (rendererReady && current !== undefined && hostPageUrl !== undefined && current.webContents.getURL() === hostPageUrl) {
		documentLanguage = await readDesktopDocumentLanguage(() => current.webContents.executeJavaScript("document.documentElement.lang"));
	}
	return desktopLocale(preference, languages, documentLanguage);
}

function liveWindow(): BrowserWindow | undefined {
	if (window === undefined || window.isDestroyed()) return undefined;
	return window;
}

function showWindow(): void {
	const current = liveWindow();
	if (current === undefined) return;
	if (current.isMinimized()) current.restore();
	current.show();
	current.focus();
}

/** Window close is reversible while the tray exists; leaving is a separate, confirmed action. */
async function refreshTrayMenu(): Promise<void> {
	if (SMOKE) return;
	try {
		if (tray === undefined) {
			const image = nativeImage.createFromPath(TRAY_ICON);
			if (image.isEmpty()) return;
			tray = new Tray(image.resize({ width: 18, height: 18 }));
			tray.setToolTip(APP_NAME);
			tray.on("click", showWindow);
			tray.on("double-click", showWindow);
		}
		const locale = await currentLocale();
		tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(locale, {
			show: showWindow,
			quit: () => { void requestUserQuit(); },
		})));
	} catch (error: unknown) {
		console.error(`desktop tray unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
}

ipcMain.handle("amazme:pick-directories", async event => {
	const current = liveWindow();
	if (!current || event.sender !== current.webContents || event.senderFrame !== current.webContents.mainFrame
		|| hostPageUrl === undefined || current.webContents.getURL() !== hostPageUrl || notices.quitting) return [];
	const pending = folderPicker ??= (async () => {
		const locale = await currentLocale();
		if (current.isDestroyed() || notices.quitting) return [];
		const result = await dialog.showOpenDialog(current, {
			title: translate(locale, "project.folders"), buttonLabel: translate(locale, "project.chooseFolder"),
			defaultPath: hostWorkingDirectory(process.env, process.cwd()), properties: ["openDirectory", "multiSelections"],
		});
		return result.canceled ? [] : result.filePaths;
	})();
	try { return await pending; } finally { if (folderPicker === pending) folderPicker = undefined; }
});

/** A hidden window cannot parent a modal. Show it before the dialog so the buttons are reachable. */
function revealWindow(): void {
	const current = liveWindow();
	if (current !== undefined && !current.isVisible()) current.show();
}

function boxOptions(
	copy: { readonly title: string; readonly message: string; readonly detail: string; readonly buttons: readonly string[] },
	cancelId: number,
): MessageBoxOptions {
	return {
		type: "error",
		title: copy.title,
		message: copy.message,
		buttons: [...copy.buttons],
		defaultId: 0,
		cancelId,
		noLink: true,
		...(copy.detail.length > 0 ? { detail: copy.detail } : {}),
	};
}

/**
 * Smoke must not block on a modal. A failure still takes the quit button so the process can
 * leave; the success path never asks.
 */
async function ask(options: MessageBoxOptions): Promise<number> {
	if (SMOKE || notices.quitting) return options.cancelId ?? 0;
	const parent = liveWindow();
	const result =
		parent === undefined ? await dialog.showMessageBox(options) : await dialog.showMessageBox(parent, options);
	return result.response;
}

function requestQuit(): void {
	notices.applicationWillQuit();
	if (quitReleased || quitRequested) return;
	quitRequested = true;
	void shutdownHost().finally(() => {
		quitReleased = true;
		app.quit();
	});
}

/** The explicit quit path asks before it stops the host; a hidden window can be reopened. */
async function requestUserQuit(): Promise<void> {
	if (quitReleased || quitRequested || showingDialog) return;
	quitPrompt ??= (async () => {
		if (SMOKE) return true;
		showWindow();
		showingDialog = true;
		try {
			const locale = await currentLocale();
			const copy = quitDialogCopy(locale);
			return await ask({
				type: "question",
				title: copy.title,
				message: copy.message,
				detail: copy.detail,
				buttons: [...copy.buttons],
				defaultId: 0,
				cancelId: 0,
				noLink: true,
			}) === 1;
		} catch (error: unknown) {
			console.error(`desktop quit dialog failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		} finally {
			showingDialog = false;
		}
	})().finally(() => { quitPrompt = undefined; });
	const confirmed = await quitPrompt;
	if (confirmed) {
		requestQuit();
		return;
	}
	// A host failure that arrived while the quit dialog was open still needs its own dialog.
	const failure = deferredHost;
	deferredHost = undefined;
	if (failure !== undefined) beginHostDialog(failure);
}

function logHostFailure(failure: HostFailure): void {
	if (failure.kind === "unexpected-exit" || failure.kind === "exit-before-ready") {
		console.error(`desktop host exited (${failure.kind}, code ${String(failure.code)}, signal ${String(failure.signal)})`);
		return;
	}
	console.error(`desktop host failed (${failure.kind}): ${failure.message}`);
}

/** The host is already unusable. Shut it down, then leave with a failure status. */
function leaveAfterHostFailure(): void {
	notices.applicationWillQuit();
	if (quitReleased || quitRequested) return;
	quitRequested = true;
	void shutdownHost().finally(() => {
		quitReleased = true;
		app.exit(1);
	});
}

function beginHostDialog(failure: HostFailure): void {
	showingDialog = true;
	revealWindow();
	void currentLocale().then((locale) => ask(boxOptions(hostFailureCopy(locale, failure), 0)))
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
		})
		.finally(() => {
			showingDialog = false;
			deferredHost = undefined;
			leaveAfterHostFailure();
		});
}

function presentHostFailure(failure: HostFailure): void {
	logHostFailure(failure);
	if (showingDialog) {
		deferredHost ??= failure;
		return;
	}
	beginHostDialog(failure);
}

function finishRenderDialog(response: number): void {
	showingDialog = false;
	const deferred = deferredHost;
	deferredHost = undefined;
	if (deferred !== undefined) {
		beginHostDialog(deferred);
		return;
	}
	const recovery = renderDialogRecovery(response, notices.quitting, hostPageUrl);
	if (recovery.kind === "load") {
		const current = liveWindow();
		if (current !== undefined) {
			void current.loadURL(recovery.url).catch((error: unknown) => {
				console.error(error instanceof Error ? error.message : String(error));
			});
			return;
		}
	}
	requestQuit();
}

function presentRenderFailure(failure: RenderFailure): void {
	if (showingDialog || notices.quitting) return;
	showingDialog = true;
	revealWindow();
	void currentLocale().then((locale) => ask(boxOptions(renderFailureCopy(locale, failure), 1))).then(
		(response) => {
			finishRenderDialog(response);
		},
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			finishRenderDialog(1);
		},
	);
}

notices = createShellController({ presentHostFailure, presentRenderFailure });

/**
 * The page title is the only signal. Electron still applies it. A rise from no pending approvals
 * to some, while this window is in the background, flashes the frame. The flash stops on focus,
 * and also when the count returns to none before then.
 */
function watchPendingApprovals(target: BrowserWindow): void {
	let pending = 0;
	target.on("focus", () => {
		target.flashFrame(false);
	});
	target.webContents.on("page-title-updated", (_event, title: string) => {
		const attention = attentionOnTitle(pending, title, target.isFocused());
		if (attention.flash !== undefined) target.flashFrame(attention.flash);
		pending = attention.pending;
	});
}

async function openWindow(pageUrl: string): Promise<void> {
	hostPageUrl = pageUrl;
	const origin = new URL(pageUrl).origin;
	const created = new BrowserWindow({
		width: 1440,
		height: 920,
		minWidth: 960,
		minHeight: 640,
		show: false,
		title: APP_NAME,
		icon: APP_ICON,
		autoHideMenuBar: true,
		webPreferences: {
			preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
		},
	});
	Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(process.platform)));
	window = created;
	created.on("closed", () => {
		if (window === created) window = undefined;
	});
	// `close` is before the renderer is torn down, so a render-process-gone from that teardown
	// already sees the quitting flag and does not dialog.
	created.on("focus", () => { void refreshTrayMenu(); });
	created.on("close", (event) => {
		if (notices.quitting) return;
		if (tray !== undefined) {
			event.preventDefault();
			if (created.isFullScreen()) created.setFullScreen(false);
			created.hide();
			return;
		}
		requestQuit();
	});
	watchPendingApprovals(created);
	let contextMenuRequest = 0;
	created.webContents.on("context-menu", (_event, params) => {
		const request = ++contextMenuRequest;
		void currentLocale().then((locale) => {
			if (request !== contextMenuRequest || created.isDestroyed() || notices.quitting || showingDialog) return;
			const template = editMenuTemplate(params, locale);
			if (template.length === 0) return;
			Menu.buildFromTemplate(
				template.map((item) => ({ role: item.role, label: item.label, enabled: item.enabled })),
			).popup({ window: created });
		}).catch((error: unknown) => console.error(error instanceof Error ? error.message : String(error)));
	});
	created.webContents.on("did-start-loading", () => { rendererReady = false; });
	created.webContents.on("did-finish-load", () => { rendererReady = true; });
	created.webContents.on("render-process-gone", (_event, details) => {
		rendererReady = false;
		notices.renderProcessGone(details);
	});
	created.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
		notices.didFailLoad({ errorCode, errorDescription, validatedURL, isMainFrame });
	});
	created.webContents.on("will-navigate", (event, target) => {
		if (isAllowedNavigation(target, origin)) return;
		event.preventDefault();
		if (isExternalUrl(target)) void shell.openExternal(target);
	});
	created.webContents.setWindowOpenHandler(({ url }) => {
		if (isExternalUrl(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	try {
		await created.loadURL(pageUrl);
	} catch (error: unknown) {
		// The did-fail-load handler owns the dialog. Rejecting here would look like a host failure.
		console.error(error instanceof Error ? error.message : String(error));
	}
	if (created.isDestroyed() || notices.quitting) return;
	created.show();
	await refreshTrayMenu();
	if (!SMOKE) return;
	const marker: unknown = await created.webContents.executeJavaScript(SMOKE_EXPRESSION);
	if (typeof marker !== "object" || marker === null) throw new Error("Invalid desktop smoke marker");
	process.stdout.write(`desktop smoke: ${created.webContents.getURL()} ${JSON.stringify({ ...marker, desktopLocale: await currentLocale() })}\n`);
	if (process.env.AMAZME_GUI_SMOKE_HOLD === "1") return;
	notices.applicationWillQuit();
	await shutdownHost();
	quitReleased = true;
	app.exit(0);
}

async function boot(): Promise<void> {
	app.dock?.setIcon(APP_ICON);
	const cliEntry = resolveHostCli();
	const launch = webHostLaunch({
		nodeExecutable: resolveNodeExecutable(process.env),
		cliEntry,
		cwd: hostWorkingDirectory(process.env, process.cwd()),
		env: process.env,
	});
	const missing = missingHostEntry(launch);
	if (missing !== undefined) {
		throw new Error(`desktop host entry is missing: ${missing}`);
	}
	const timeout = readinessTimeout();
	host = createHostSupervisor({
		spawnHost: () => {
			const child = spawnWebHost(launch);
			if (SMOKE && child.pid !== undefined) process.stdout.write(`desktop host pid: ${child.pid}\n`);
			return child;
		},
		...(timeout === undefined ? {} : { readinessTimeoutMs: timeout }),
		log: (chunk) => {
			process.stderr.write(chunk);
		},
		onStartupFailure: (failure) => {
			startupFailure = failure;
		},
		onUnexpectedExit: (detail) => {
			notices.hostExited(detail);
		},
	});
	const pageUrl = await host.start();
	await openWindow(pageUrl);
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", showWindow);
	app.on("activate", showWindow);
	app.on("window-all-closed", () => {
		if (tray === undefined || SMOKE) app.quit();
	});
	app.on("before-quit", (event: ElectronEvent) => {
		if (quitReleased) return;
		event.preventDefault();
		if (quitRequested) return;
		if (notices.quitting) {
			requestQuit();
			return;
		}
		void requestUserQuit();
	});
	app.whenReady().then(boot).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		const failure: HostFailure = startupFailure ?? {
			kind: "startup-error",
			message,
			tail: host?.tail() ?? "",
		};
		notices.startupFailed(failure);
	});
}
