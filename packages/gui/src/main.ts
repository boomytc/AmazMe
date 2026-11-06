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
	Notification,
	shell,
	Tray,
	type Event as ElectronEvent,
	type MessageBoxOptions,
} from "electron";
import { desktopLocale, readDesktopDocumentLanguage } from "./locale.ts";
import { closeDialogCopy, hostFailureCopy, lifecycleErrorCopy, renderDialogRecovery, renderFailureCopy, type HostFailure, type RenderFailure } from "./dialogs.ts";
import { createHostConnection, type HostStartupFailure, type HostSupervisor } from "./host.ts";
import { PythonDesktopApi } from "./desktop-api.ts";
import { createDesktopLifecycle, type DesktopLifecycle, type LifecycleError } from "./lifecycle.ts";
import { hostWorkingDirectory } from "./launch.ts";
import { applicationMenuTemplate, editMenuTemplate } from "./menu.ts";
import { isAllowedNavigation, isExternalUrl, isHostPageDocument } from "./navigation.ts";
import { createShellController, type ShellController } from "./shell.ts";
import { desktopDataDirectory } from "./data-directory.ts";
import { withWindowTarget, type WindowAddress } from "./deep-link.ts";
import { attentionOnTitle } from "./title.ts";
import { trayMenuTemplate } from "./tray.ts";
import { translate } from "@amazme/web/strings";
import { readControlToken, requirePythonBackend } from "./python-backend.ts";

const APP_NAME = "AmazMe";
const APP_ICON = join(PAGE_DIRECTORY, "app-icon.png");
const TRAY_ICON = fileURLToPath(new URL("../assets/tray-icon.png", import.meta.url));
app.setName(APP_NAME);
const SMOKE = process.env.AMAZME_GUI_SMOKE === "1";
app.setPath("userData", desktopDataDirectory(process.env));
if (SMOKE && !process.env.AMAZME_PROFILE && !process.env.AMAZME_AGENT_DIR && !process.env.AMAZME_HOME) throw new Error("desktop smoke requires an isolated profile");

const SMOKE_EXPRESSION = `({
	title: document.title,
	boot: globalThis.__AMAZME_BOOT__ != null && typeof globalThis.__AMAZME_BOOT__ === "object",
	name: globalThis.__AMAZME_BOOT__ && globalThis.__AMAZME_BOOT__.app && globalThis.__AMAZME_BOOT__.app.name,
	mode: globalThis.__AMAZME_BOOT__ && globalThis.__AMAZME_BOOT__.mode,
	serverId: globalThis.__AMAZME_BOOT__ && globalThis.__AMAZME_BOOT__.server && globalThis.__AMAZME_BOOT__.server.id,
	language: document.documentElement.lang,
	transport: globalThis.__AMAZME_BOOT__ && globalThis.__AMAZME_BOOT__.transport && globalThis.__AMAZME_BOOT__.transport.url
})`;

let host: HostSupervisor | undefined;
/** The host URL without a deep link: what a new window opens. */
let hostPageUrl: string | undefined;
/** Open windows. Each has its own in-memory storage partition and its own session selection. */
const windows = new Set<BrowserWindow>();
const pageUrls = new Map<number, string>();
const readiedWindows = new Set<number>();
const windowPending = new Map<number, number>();
let nextWindowPartition = 0;
let showingDialog = false;
let deferredHost: HostFailure | undefined;
/** AMAZME_GUI_SESSION opens one conversation without changing the shared last-selection file. */
const deepLinkSession = process.env.AMAZME_GUI_SESSION;
let startupFailure: HostStartupFailure | undefined;
let folderPicker: Promise<readonly string[]> | undefined;
let tray: Tray | undefined;
let notices: ShellController;
let lifecycle: DesktopLifecycle<BrowserWindow>;
let desktopApi: PythonDesktopApi;
let pythonProfile = "";
let pythonWebToken = "";
let selectedWorkspace = "primary";

function readinessTimeout(): number | undefined {
	const raw = process.env.AMAZME_GUI_READY_TIMEOUT_MS;
	if (raw === undefined || raw.length === 0) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function shutdownHost(): Promise<void> {
	if (host === undefined) return Promise.resolve();
	return host.shutdown();
}

async function currentLocale() {
	const preferred = app.getPreferredSystemLanguages();
	const system = app.getLocale();
	const languages = preferred.length > 0 ? preferred : system.length > 0 ? [system] : [];
    const preference = await desktopApi.localePreference().catch(() => undefined);
	const current = liveWindow();
	let documentLanguage: unknown;
	// Constant read from the owned page, not a new renderer capability or arbitrary IPC execution.
	const pageUrl = current === undefined ? undefined : pageUrls.get(current.id);
	if (current !== undefined && pageUrl !== undefined && readiedWindows.has(current.id) && isHostPageDocument(current.webContents.getURL(), pageUrl)) {
		documentLanguage = await readDesktopDocumentLanguage(() => current.webContents.executeJavaScript("document.documentElement.lang"));
	}
	return desktopLocale(preference, languages, documentLanguage);
}

function liveWindows(): BrowserWindow[] {
	return [...windows].filter((candidate) => !candidate.isDestroyed());
}

/** The window an action applies to: the focused one, else a visible one, else any open one. */
function liveWindow(): BrowserWindow | undefined {
	const focused = BrowserWindow.getFocusedWindow();
	if (focused !== null && windows.has(focused) && !focused.isDestroyed()) return focused;
	const open = liveWindows();
	return open.find((candidate) => candidate.isVisible()) ?? open[0];
}

function totalPendingApprovals(): number {
	let total = 0;
	for (const count of windowPending.values()) total += count;
	return total;
}

function showWindow(): void {
	const current = liveWindow();
	if (current === undefined) return;
	if (current.isMinimized()) current.restore();
	current.show();
	current.focus();
}

/** The application menu carries the two session actions the shell can perform for the page. */
async function refreshApplicationMenu(): Promise<void> {
	try {
		const locale = await currentLocale();
		const send = (action: "new-session" | "settings") => {
			const current = liveWindow();
			if (current === undefined || current.isDestroyed()) return;
			current.webContents.send("amazme:menu-action", action);
		};
		Menu.setApplicationMenu(
			Menu.buildFromTemplate(
				applicationMenuTemplate(process.platform, locale, {
					newSession: () => send("new-session"),
					newWindow: () => {
						if (hostPageUrl !== undefined) void openWindow(hostPageUrl, pythonWindow({ workspace: selectedWorkspace, fresh: true }));
					},
					settings: () => send("settings"),
				}),
			),
		);
	} catch (error: unknown) {
		console.error(`desktop menu unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
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
		const pending = totalPendingApprovals();
		tray.setToolTip(pending > 0 ? `${APP_NAME} · ${pending}` : APP_NAME);
		tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(locale, {
			show: showWindow,
			quit: () => { void requestUserQuit(); },
		}, pending)));
	} catch (error: unknown) {
		console.error(`desktop tray unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
}

ipcMain.handle("amazme:pick-directories", async event => {
	const current = liveWindows().find((candidate) => candidate.webContents === event.sender);
	const pageUrl = current === undefined ? undefined : pageUrls.get(current.id);
	if (!current || pageUrl === undefined || event.senderFrame !== current.webContents.mainFrame
		|| !isHostPageDocument(current.webContents.getURL(), pageUrl) || notices.quitting) return [];
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

/**
 * Keep the native window backdrop on the canvas the page paints, so a resize or theme flip never
 * shows a stale fill. Only a window's own main frame may ask, and the colour is a plain hex fill.
 */
ipcMain.on("amazme:set-window-background", (event, value: unknown) => {
	if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/u.test(value)) return;
	const sender = event.sender;
	const target = BrowserWindow.fromWebContents(sender);
	if (target === null || target.isDestroyed() || event.senderFrame !== sender.mainFrame) return;
	target.setBackgroundColor(value);
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
	void lifecycle.quitImmediately();
}

async function requestUserQuit(): Promise<void> {
	await lifecycle.requestQuit();
}

function finishLifecycleDialog(): void {
	showingDialog = false;
	const failure = deferredHost;
	deferredHost = undefined;
	if (failure !== undefined && !notices.quitting) beginHostDialog(failure);
}

function logHostFailure(failure: HostFailure): void {
	if (failure.kind === "unexpected-exit" || failure.kind === "exit-before-ready") {
		console.error(`desktop host exited (${failure.kind}, code ${String(failure.code)}, signal ${String(failure.signal)})`);
		return;
	}
	console.error(`desktop host failed (${failure.kind}): ${failure.message}`);
}

/** Leaving a failed desktop never stops a shared Host. */
function leaveAfterHostFailure(): void {
    if (notices.quitting) return;
    notices.applicationWillQuit();
    app.exit(1);
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

async function lifecycleBox(options: () => Promise<MessageBoxOptions>, cancelId: number, target?: BrowserWindow): Promise<{ readonly response: number; readonly checkboxChecked: boolean }> {
	if (SMOKE) return { response: cancelId, checkboxChecked: false };
	if (target !== undefined && !target.isDestroyed()) target.show();
	else showWindow();
	showingDialog = true;
	try {
		const requested = await options();
		const parent = target !== undefined && !target.isDestroyed() ? target : liveWindow();
		return parent === undefined ? await dialog.showMessageBox(requested) : await dialog.showMessageBox(parent, requested);
	} catch (error: unknown) {
		console.error(`desktop lifecycle dialog failed: ${error instanceof Error ? error.message : String(error)}`);
		return { response: cancelId, checkboxChecked: false };
	} finally {
		finishLifecycleDialog();
	}
}

desktopApi = new PythonDesktopApi(() => host?.pythonReady(), () => pythonProfile, () => pythonWebToken);
lifecycle = createDesktopLifecycle<BrowserWindow>({
	readPreferences: () => desktopApi.readPreferences(),
	readActivity: () => desktopApi.activity(),
	savePreferences: value => desktopApi.savePreferences(value),
	confirmClose: async target => {
		const result = await lifecycleBox(async () => {
			const copy = closeDialogCopy(await currentLocale());
			return {
				type: "question", title: copy.title, message: copy.message, detail: copy.detail,
				buttons: [...copy.buttons], defaultId: 0, cancelId: 2, noLink: true,
				checkboxLabel: copy.checkboxLabel, checkboxChecked: false,
			};
		}, 2, target);
		return {
			choice: result.response === 0 ? "background" : result.response === 1 ? "quit" : "cancel",
			remember: result.response !== 2 && result.checkboxChecked,
		};
	},

	reportError: async (kind: LifecycleError) => {
		const result = await lifecycleBox(async () => {
			const copy = lifecycleErrorCopy(await currentLocale(), kind);
			return {
				type: "warning", title: copy.title, message: copy.message, detail: copy.detail,
				buttons: [...copy.buttons], defaultId: 0, cancelId: 1, noLink: true,
			};
		}, 1);
		return result.response === 0;
	},
	hideWindow: target => {
		if (target.isDestroyed()) return;
		if (target.isFullScreen()) target.setFullScreen(false);
		target.hide();
	},
	stopBackend: () => shutdownHost(),
	applicationWillQuit: () => notices.applicationWillQuit(),
	releaseQuit: () => app.quit(),
});

/**
 * The page title is the only signal. Electron still applies it. A rise from no pending approvals
 * to some, while this window is in the background, flashes the frame. The flash stops on focus,
 * and also when the count returns to none before then.
 */
function updateApprovalIndicators(): void {
	const pending = totalPendingApprovals();
	app.dock?.setBadge(pending > 0 ? String(pending) : "");
	void refreshTrayMenu();
}

function watchPendingApprovals(target: BrowserWindow): void {
	let pending = 0;
	target.on("focus", () => {
		target.flashFrame(false);
	});
	target.on("closed", () => {
		windowPending.delete(target.id);
		updateApprovalIndicators();
	});
	target.webContents.on("page-title-updated", (_event, title: string) => {
		// A hidden window cannot flash, so a rise also raises a system notification.
		const attention = attentionOnTitle(pending, title, target.isFocused(), target.isVisible());
		if (attention.flash !== undefined) target.flashFrame(attention.flash);
		if (attention.notify) void announceApprovals(title, attention.pending, target);
		pending = attention.pending;
		windowPending.set(target.id, attention.pending);
		updateApprovalIndicators();
	});
}

/** One notification per rise; clicking it brings that window back with the approval in front. */
async function announceApprovals(title: string, count: number, target: BrowserWindow): Promise<void> {
	if (SMOKE || !Notification.isSupported()) return;
	try {
		const locale = await currentLocale();
		const notification = new Notification({
			title: translate(locale, "desktop.notify.pending", { count: String(count) }),
			body: title,
		});
		notification.on("click", () => {
			if (target.isDestroyed()) return;
			if (target.isMinimized()) target.restore();
			target.show();
			target.focus();
		});
		notification.show();
	} catch (error: unknown) {
		console.error(`desktop notification unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function pythonWindow(target: WindowAddress): WindowAddress {
	const hostId = host?.pythonReady()?.profileId;
	return hostId === undefined || hostId.length === 0 ? target : { ...target, hostId };
}

async function openWindow(pageUrl: string, target: WindowAddress = {}): Promise<void> {
	hostPageUrl ??= pageUrl;
	const addressed = withWindowTarget(pageUrl, target);
	const origin = new URL(addressed).origin;
	nextWindowPartition += 1;
	const created = new BrowserWindow({
		width: 1440,
		height: 920,
		// Rail 56 + sidebar 268 + the dock's 320px floor leaves 540px for the conversation here.
		minWidth: 1184,
		minHeight: 640,
		show: false,
		title: APP_NAME,
		icon: APP_ICON,
		autoHideMenuBar: true,
		// The page draws its own 48px toolbar. macOS hides the native title bar and keeps the traffic
		// lights inside that row; the renderer reserves the leading 78px, so the two values move together.
		...(process.platform === "darwin"
			? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } }
			: {}),
		webPreferences: {
			preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
			// A window is its own tab: drafts and last selection stay out of the other windows.
			partition: `amazme-window-${nextWindowPartition}`,
		},
	});
	windows.add(created);
	pageUrls.set(created.id, addressed);
	void refreshApplicationMenu();
	created.on("closed", () => {
		windows.delete(created);
		pageUrls.delete(created.id);
		readiedWindows.delete(created.id);
	});
	// `close` is before the renderer is torn down, so a render-process-gone from that teardown
	// already sees the quitting flag and does not dialog.
	created.on("focus", () => {
		void refreshTrayMenu();
		void refreshApplicationMenu();
	});
	created.on("close", (event) => {
		if (lifecycle.allowQuit()) return;
		event.preventDefault();
		void lifecycle.requestClose(created);
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
	created.webContents.on("did-start-loading", () => { readiedWindows.delete(created.id); });
	created.webContents.on("did-finish-load", () => { readiedWindows.add(created.id); });
	created.webContents.on("render-process-gone", (_event, details) => {
		readiedWindows.delete(created.id);
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
		await created.loadURL(addressed);
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
	app.exit(0);
}

async function boot(): Promise<void> {
	app.dock?.setIcon(APP_ICON);
	const pythonExecutable = requirePythonBackend(process.env.AMAZME_PYTHON_BACKEND);
	const cwd = hostWorkingDirectory(process.env, process.cwd());
    host = createHostConnection({
        executable: pythonExecutable, cwd, env: process.env,
        ...(readinessTimeout() === undefined ? {} : { readinessTimeoutMs: readinessTimeout() }),
        onStartupFailure: failure => { startupFailure = failure; },
    });
    const pageUrl = await host.start();
    const connection = host.connection();
    if (connection === undefined) throw new Error("local_host_unavailable");
    pythonProfile = connection.profilePath;
    pythonWebToken = connection.webToken;
    selectedWorkspace = connection.workspace;
    if (pythonWebToken === readControlToken(pythonProfile)) throw new Error("desktop control token is not distinct");
	const namedSession = deepLinkSession?.trim();
	await openWindow(pageUrl, pythonWindow(namedSession ? { sessionId: namedSession, workspace: selectedWorkspace } : { workspace: selectedWorkspace }));
}

async function initializeDesktop(): Promise<void> {
	if (!app.requestSingleInstanceLock()) { app.quit(); return; }

	app.on("second-instance", (_event, argv) => {
		const fresh = argv.some((arg) => arg === "--amazme-new-window");
		if (fresh && hostPageUrl !== undefined) {
			process.stdout.write("desktop window requested\n");
			void openWindow(hostPageUrl, pythonWindow({ workspace: selectedWorkspace, fresh: true }));
			return;
		}
		showWindow();
	});
	app.on("activate", () => {
		if (liveWindows().length === 0 && hostPageUrl !== undefined) void openWindow(hostPageUrl, pythonWindow({ workspace: selectedWorkspace }));
		else showWindow();
	});
	app.on("window-all-closed", () => {
		if (SMOKE) app.quit();
	});
	app.on("before-quit", (event: ElectronEvent) => {
		if (lifecycle.allowQuit()) return;
		event.preventDefault();
		if (notices.quitting) {
			requestQuit();
			return;
		}
		void requestUserQuit();
	});
	app.whenReady().then(boot).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		if (SMOKE) {
			process.stdout.write(`desktop backend refused: ${message}\n`);
			app.exit(1);
			return;
		}
		const failure: HostFailure = startupFailure ?? {
			kind: "startup-error",
			message,
			tail: host?.tail() ?? "",
		};
		notices.startupFailed(failure);
	});
}

void initializeDesktop().catch(() => { console.error("desktop startup unavailable"); app.exit(1); });
