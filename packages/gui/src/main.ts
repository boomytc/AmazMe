import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
import { desktopLocale, readDesktopDocumentLanguage, readDesktopLocalePreference } from "./locale.ts";
import { hostFailureCopy, quitDialogCopy, renderDialogRecovery, renderFailureCopy, type HostFailure, type RenderFailure } from "./dialogs.ts";
import { createHostSupervisor, spawnNodeChild, type HostStartupFailure, type HostSupervisor } from "./host.ts";
import { hostWorkingDirectory } from "./launch.ts";
import { applicationMenuTemplate, editMenuTemplate } from "./menu.ts";
import { isAllowedNavigation, isExternalUrl } from "./navigation.ts";
import { createShellController, type ShellController } from "./shell.ts";
import { withWindowTarget, type WindowAddress } from "./deep-link.ts";
import { attentionOnTitle } from "./title.ts";
import { trayMenuTemplate } from "./tray.ts";
import { translate } from "@amazme/web/strings";
import { createDesktopUpdates } from "./desktop-updates.ts";
import { markUpdatedDesktopHealthy } from "./update-helper.ts";
import { mayStartInstalledApp, shouldStartDesktopUpdates } from "./update-launch.ts";
import { recoverStaleUpdateLock, updateLockState } from "./update-lock.ts";
import {
	desktopPythonBootPlan,
	initialPythonProvider,
	parsePythonUpdateRecord,
	pythonPrepareUpdateRequest,
	pythonShutdownRequest,
	pythonUpdateStatePath,
	readControlToken,
	requirePythonBackend,
	resolvePythonBackend,
	settlePythonBackendUpdate,
	shouldStopSharedBackend,
	windowCloseAction,
} from "./python-backend.ts";

const execFileAsync = promisify(execFile);

const APP_NAME = "AmazMe";
const APP_ICON = join(PAGE_DIRECTORY, "app-icon.png");
const TRAY_ICON = fileURLToPath(new URL("../assets/tray-icon.png", import.meta.url));
app.setName(APP_NAME);
const SMOKE = process.env.AMAZME_GUI_SMOKE === "1";
if (process.env.AMAZME_GUI_USER_DATA_DIR && isAbsolute(process.env.AMAZME_GUI_USER_DATA_DIR)) app.setPath("userData", process.env.AMAZME_GUI_USER_DATA_DIR);
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
/** The host URL without a deep link: what a new window opens. */
let hostPageUrl: string | undefined;
/** Open windows. Each has its own in-memory storage partition and its own session selection. */
const windows = new Set<BrowserWindow>();
const pageUrls = new Map<number, string>();
const readiedWindows = new Set<number>();
const windowPending = new Map<number, number>();
let nextWindowPartition = 0;
let shutdownPromise: Promise<void> | undefined;
let quitReleased = false;
let quitRequested = false;
let showingDialog = false;
let deferredHost: HostFailure | undefined;
/** AMAZME_GUI_SESSION opens one conversation without changing the shared last-selection file. */
const deepLinkSession = process.env.AMAZME_GUI_SESSION;
let startupFailure: HostStartupFailure | undefined;
let folderPicker: Promise<readonly string[]> | undefined;
let tray: Tray | undefined;
let quitPrompt: Promise<boolean> | undefined;
let notices: ShellController;
let updates: ReturnType<typeof createDesktopUpdates> | undefined;
const desktopUpdateToken = randomBytes(32).toString("hex");
let usingPythonBackend = false;
let pythonProfile = "";
let pythonWebToken = "";

async function stopPythonBackend(): Promise<void> {
	const ready = host?.pythonReady();
	if (!usingPythonBackend || ready === undefined || pythonProfile.length === 0 || pythonWebToken.length === 0) return;
	try {
		const request = pythonShutdownRequest(ready, readControlToken(pythonProfile), pythonWebToken);
		const response = await fetch(request.url, {
			method: "POST", redirect: "error", headers: request.headers, body: request.body, signal: AbortSignal.timeout(request.timeoutMs),
		});
		await response.body?.cancel();
	} catch (error: unknown) {
		console.error(`desktop python shutdown failed: ${error instanceof Error ? error.message : "request failed"}`);
	}
}

function pythonUpdateFile(): string {
	return pythonUpdateStatePath(app.getPath("userData"));
}

function readPendingPythonUpdate(): { readonly updateId?: string; readonly targetBuild?: string } | undefined {
	const path = pythonUpdateFile();
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as { readonly update_id?: unknown; readonly target_build?: unknown };
		return {
			...(typeof record.update_id === "string" ? { updateId: record.update_id } : {}),
			...(typeof record.target_build === "string" ? { targetBuild: record.target_build } : {}),
		};
	} catch {
		return undefined;
	}
}

function writePendingPythonUpdate(value: { readonly updateId?: string; readonly targetBuild: string }): void {
	const path = pythonUpdateFile();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, JSON.stringify({
		...(value.updateId === undefined ? {} : { update_id: value.updateId }),
		target_build: value.targetBuild,
	}), { mode: 0o600 });
}

function clearPendingPythonUpdate(): void {
	const path = pythonUpdateFile();
	if (existsSync(path)) unlinkSync(path);
}

async function controlCall(path: string, method: string, body?: string): Promise<{ readonly ok: boolean; readonly status: number; readonly value: unknown }> {
	const ready = host?.pythonReady();
	if (ready === undefined || pythonProfile.length === 0) return { ok: false, status: 0, value: undefined };
	const response = await fetch(`${ready.origin}${path}`, {
		method,
		redirect: "error",
		headers: {
			Authorization: `Bearer ${readControlToken(pythonProfile)}`,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body }),
		signal: AbortSignal.timeout(120_000),
	});
	const text = await response.text();
	let value: unknown;
	if (text.length > 0) {
		try { value = JSON.parse(text) as unknown; } catch { value = undefined; }
	}
	return { ok: response.ok, status: response.status, value };
}

/** Verify on the target build, then activate. The source build is left frozen. */
async function settlePythonUpdate(): Promise<void> {
	const ready = host?.pythonReady();
	if (!usingPythonBackend || ready === undefined) return;
	await settlePythonBackendUpdate(ready, readControlToken(pythonProfile), pythonWebToken);
	if (readPendingPythonUpdate()?.updateId !== undefined) clearPendingPythonUpdate();
}

async function updateHostAdmission(action: "prepare" | "resume"): Promise<boolean> {
	if (usingPythonBackend) {
		const ready = host?.pythonReady();
		if (ready === undefined || pythonWebToken.length === 0 || pythonProfile.length === 0) return false;
		try {
			if (action === "prepare") {
				const target = readPendingPythonUpdate()?.targetBuild ?? process.env.AMAZME_PYTHON_TARGET_BUILD ?? "";
				const updateId = randomBytes(8).toString("hex");
				const request = pythonPrepareUpdateRequest(ready, readControlToken(pythonProfile), pythonWebToken, updateId, target);
				const response = await controlCall(new URL(request.url).pathname, "POST", request.body);
				const prepared = parsePythonUpdateRecord(response.value);
				if (!response.ok || prepared === undefined || prepared.activated || prepared.phase !== "prepared") return false;
				writePendingPythonUpdate({ updateId: prepared.updateId, targetBuild: prepared.targetBuild });
				return true;
			}
			await settlePythonUpdate();
			return true;
		} catch (error: unknown) {
			console.error(`desktop python update failed: ${error instanceof Error ? error.message : "request failed"}`);
			return false;
		}
	}
	if (!hostPageUrl) return false;
	try {
		const response = await fetch(new URL(`/desktop-update/${action}`, hostPageUrl), { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { "x-amazme-desktop-update": desktopUpdateToken } });
		await response.body?.cancel(); return response.ok;
	} catch { return false; }
}

function readinessTimeout(): number | undefined {
	const raw = process.env.AMAZME_GUI_READY_TIMEOUT_MS;
	if (raw === undefined || raw.length === 0) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function shutdownHost(): Promise<void> {
	shutdownPromise ??= (async () => {
		await stopPythonBackend();
		await (host?.shutdown() ?? Promise.resolve());
	})();
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
	const pageUrl = current === undefined ? undefined : pageUrls.get(current.id);
	if (current !== undefined && pageUrl !== undefined && readiedWindows.has(current.id) && current.webContents.getURL() === pageUrl) {
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
						if (hostPageUrl !== undefined) void openWindow(hostPageUrl, pythonWindow({ workspace: "primary", fresh: true }));
					},
					settings: () => send("settings"),
					...(updates === undefined ? {} : { updates: () => { void updates?.show(); } }),
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
		|| current.webContents.getURL() !== pageUrl || notices.quitting) return [];
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
		void updates?.dispose().finally(() => { quitReleased = true; app.quit(); });
		if (updates === undefined) { quitReleased = true; app.quit(); }
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
		minWidth: 1024,
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
		const action = windowCloseAction({ quitting: notices.quitting, pythonBackend: usingPythonBackend, tray: tray !== undefined });
		if (action === "allow") return;
		event.preventDefault();
		if (action === "hide") {
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
	quitReleased = true;
	app.exit(0);
}

async function boot(): Promise<void> {
	app.dock?.setIcon(APP_ICON);
	const pythonExecutable = requirePythonBackend(resolvePythonBackend(process.env, process.resourcesPath));
	const cwd = hostWorkingDirectory(process.env, process.cwd());
	usingPythonBackend = true;
	pythonProfile = join(app.getPath("userData"), "python-profile");
	const provider = join(app.getPath("userData"), "initial-provider.json");
	if (!existsSync(provider)) {
		writeFileSync(provider, JSON.stringify(initialPythonProvider(SMOKE)));
	}
	const plan = desktopPythonBootPlan({
		executable: pythonExecutable,
		profile: pythonProfile,
		workspace: cwd,
		providerConfig: provider,
		profileExists: existsSync(join(pythonProfile, "config.json")),
		cwd,
		env: process.env,
	});
	const missingPython = plan.entries.find((entry) => !existsSync(entry));
	if (missingPython !== undefined) throw new Error(`desktop python backend is missing: ${missingPython}`);
	for (const step of plan.preflight) {
		await execFileAsync(plan.executable, [...step.args], { cwd: plan.cwd, env: plan.env });
	}
	pythonWebToken = readFileSync(join(pythonProfile, "web.token"), "utf8").trim();
	if (pythonWebToken.length === 0 || pythonWebToken === readControlToken(pythonProfile)) {
		throw new Error("desktop python web token is missing or matches the control token");
	}
	const launch = { executable: plan.executable, args: plan.serveArgs, cwd: plan.cwd, env: plan.env, entries: plan.entries };
	const timeout = readinessTimeout();
	host = createHostSupervisor({
		spawnHost: () => {
			const child = spawnNodeChild({ executable: launch.executable, args: launch.args, cwd: launch.cwd, env: launch.env });
			if (child.pid !== undefined) process.stdout.write(`desktop host pid: ${child.pid}\n`);
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
	if (usingPythonBackend) await settlePythonUpdate();
	const namedSession = deepLinkSession?.trim();
	await openWindow(pageUrl, pythonWindow(namedSession ? { sessionId: namedSession, workspace: "primary" } : { workspace: "primary", fresh: true }));
	const installedRelease = app.isPackaged && existsSync(join(process.resourcesPath, "release-manifest.json"));
	if (!SMOKE && !notices.quitting && shouldStartDesktopUpdates(installedRelease, app.getVersion())) {
		const target = dirname(dirname(dirname(process.execPath)));
		if (process.argv.includes("--amazme-update-job")) {
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				const current = liveWindow();
				const ready = current && readiedWindows.has(current.id) && await current.webContents.executeJavaScript("document.getElementById('connection-status')?.dataset.state === 'connected'").catch(() => false);
				if (ready) { await markUpdatedDesktopHealthy(process.argv, target, app.getVersion()); break; }
				await new Promise<void>(resolve => setTimeout(resolve, 100));
			}
		}
		updates = createDesktopUpdates({ version: app.getVersion(), executable: process.execPath, userData: app.getPath("userData"), locale: currentLocale,
			confirmQuit: async () => {
				if (showingDialog || quitRequested || totalPendingApprovals() > 0) throw new Error("busy");
				showingDialog = true; showWindow();
				try {
					const locale = await currentLocale();
					const confirmed = await ask({ type: "question", message: translate(locale, "desktop.update.installConfirm"), detail: translate(locale, "desktop.update.installDetail"),
						buttons: [translate(locale, "desktop.update.later"), translate(locale, "desktop.update.installAction")], defaultId: 0, cancelId: 0, noLink: true }) === 1;
					if (!confirmed) return false;
					return true;
				} finally { showingDialog = false; }
			},
			prepareHost: () => updateHostAdmission("prepare"),
			quit: async () => { requestQuit(); },
			resumeHost: async () => { await settlePythonUpdate(); },
		});
		await updates.start();
		await refreshApplicationMenu();
	}
}

async function initializeDesktop(): Promise<void> {
	const target = dirname(dirname(dirname(process.execPath)));
	if (!mayStartInstalledApp(target, app.getVersion(), process.argv)) {
		// Gate-only launches never keep an app-named dialog/process alive during replacement.
		if (updateLockState(target) !== "stale") { process.stdout.write("desktop update startup blocked\n"); app.exit(0); return; }
		if (!app.requestSingleInstanceLock()) { app.quit(); return; }
		const recovery = await recoverStaleUpdateLock(target, app.getVersion(), process.arch);
		if (recovery !== "recovered") { app.releaseSingleInstanceLock(); process.stdout.write("desktop update startup blocked\n"); app.exit(0); return; }
		process.stdout.write("desktop update stale lock recovered\n");
	} else if (!app.requestSingleInstanceLock()) { app.quit(); return; }

	app.on("second-instance", (_event, argv) => {
		const fresh = argv.some((arg) => arg === "--amazme-new-window");
		if (fresh && hostPageUrl !== undefined) {
			process.stdout.write("desktop window requested\n");
			void openWindow(hostPageUrl, pythonWindow({ workspace: "primary", fresh: true }));
			return;
		}
		showWindow();
	});
	app.on("activate", () => {
		if (liveWindows().length === 0 && hostPageUrl !== undefined) void openWindow(hostPageUrl, pythonWindow({ workspace: "primary", fresh: true }));
		else showWindow();
	});
	app.on("window-all-closed", () => {
		if (usingPythonBackend && !shouldStopSharedBackend("window-closed")) return;
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
