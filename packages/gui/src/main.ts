import {
	app,
	BrowserWindow,
	dialog,
	Menu,
	shell,
	type Event as ElectronEvent,
	type MessageBoxOptions,
} from "electron";
import { resolveLocale } from "@amazme/web/locale";
import { hostFailureCopy, renderDialogRecovery, renderFailureCopy, type HostFailure, type RenderFailure } from "./dialogs.ts";
import { createHostSupervisor, spawnWebHost, type HostStartupFailure, type HostSupervisor } from "./host.ts";
import {
	hostWorkingDirectory,
	missingHostEntry,
	repositoryRootFromModule,
	resolveNodeExecutable,
	webHostLaunch,
} from "./launch.ts";
import { editMenuTemplate } from "./menu.ts";
import { isAllowedNavigation, isExternalUrl } from "./navigation.ts";
import { createShellController, type ShellController } from "./shell.ts";
import { attentionOnTitle } from "./title.ts";

const APP_NAME = "AmazMe";
const SMOKE = process.env.AMAZME_GUI_SMOKE === "1";

const SMOKE_EXPRESSION = `({
	title: document.title,
	boot: globalThis.__AMAZME_BOOT__ != null && typeof globalThis.__AMAZME_BOOT__ === "object",
	name: globalThis.__AMAZME_BOOT__ && globalThis.__AMAZME_BOOT__.app && globalThis.__AMAZME_BOOT__.app.name,
	version: globalThis.__AMAZME_BOOT__ && globalThis.__AMAZME_BOOT__.app && globalThis.__AMAZME_BOOT__.app.version,
	mode: globalThis.__AMAZME_BOOT__ && globalThis.__AMAZME_BOOT__.mode,
	transport: globalThis.__AMAZME_BOOT__ && globalThis.__AMAZME_BOOT__.transport && globalThis.__AMAZME_BOOT__.transport.url
})`;

let host: HostSupervisor | undefined;
let hostPageUrl: string | undefined;
let window: BrowserWindow | undefined;
let shutdownPromise: Promise<void> | undefined;
let quitReleased = false;
let quitRequested = false;
let showingDialog = false;
let deferredHost: HostFailure | undefined;
let startupFailure: HostStartupFailure | undefined;
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

function currentLocale() {
	const preferred = app.getPreferredSystemLanguages();
	if (preferred.length > 0) return resolveLocale(undefined, preferred);
	const locale = app.getLocale();
	return resolveLocale(undefined, locale.length > 0 ? [locale] : []);
}

function liveWindow(): BrowserWindow | undefined {
	if (window === undefined || window.isDestroyed()) return undefined;
	return window;
}

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
	if (SMOKE) return options.cancelId ?? 0;
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
	void ask(boxOptions(hostFailureCopy(currentLocale(), failure), 0))
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
	const copy = renderFailureCopy(currentLocale(), failure);
	void ask(boxOptions(copy, 1)).then(
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
		autoHideMenuBar: true,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
		},
	});
	window = created;
	created.on("closed", () => {
		if (window === created) window = undefined;
	});
	// `close` is before the renderer is torn down, so a render-process-gone from that teardown
	// already sees the quitting flag and does not dialog.
	created.on("close", () => {
		notices.userClosedWindow();
	});
	watchPendingApprovals(created);
	created.webContents.on("context-menu", (_event, params) => {
		const template = editMenuTemplate(params, currentLocale());
		if (template.length === 0) return;
		Menu.buildFromTemplate(
			template.map((item) => ({ role: item.role, label: item.label, enabled: item.enabled })),
		).popup({ window: created });
	});
	created.webContents.on("render-process-gone", (_event, details) => {
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
	if (!SMOKE) return;
	const marker: unknown = await created.webContents.executeJavaScript(SMOKE_EXPRESSION);
	process.stdout.write(`desktop smoke: ${created.webContents.getURL()} ${JSON.stringify(marker)}\n`);
	notices.applicationWillQuit();
	await shutdownHost();
	quitReleased = true;
	app.exit(0);
}

async function boot(): Promise<void> {
	const repositoryRoot = repositoryRootFromModule(import.meta.url);
	const launch = webHostLaunch({
		nodeExecutable: resolveNodeExecutable(process.env),
		repositoryRoot,
		cwd: hostWorkingDirectory(process.env, repositoryRoot),
		env: process.env,
	});
	const missing = missingHostEntry(launch);
	if (missing !== undefined) {
		throw new Error(`desktop host entry is missing: ${missing}`);
	}
	const timeout = readinessTimeout();
	host = createHostSupervisor({
		spawnHost: () => spawnWebHost(launch),
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
	app.on("second-instance", () => {
		if (window === undefined) return;
		if (window.isMinimized()) window.restore();
		window.focus();
	});
	app.on("window-all-closed", () => {
		app.quit();
	});
	app.on("before-quit", (event: ElectronEvent) => {
		if (quitReleased) return;
		event.preventDefault();
		if (shutdownPromise !== undefined) return;
		requestQuit();
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
