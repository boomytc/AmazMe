import { app, BrowserWindow, shell, type Event as ElectronEvent } from "electron";
import { createHostSupervisor, spawnWebHost, type HostSupervisor } from "./host.ts";
import {
	hostWorkingDirectory,
	missingHostEntry,
	repositoryRootFromModule,
	resolveNodeExecutable,
	webHostLaunch,
} from "./launch.ts";
import { isAllowedNavigation, isExternalUrl } from "./navigation.ts";

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
let window: BrowserWindow | undefined;
let shutdownPromise: Promise<void> | undefined;
let quitReleased = false;

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

async function openWindow(pageUrl: string): Promise<void> {
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
	created.webContents.on("will-navigate", (event, target) => {
		if (isAllowedNavigation(target, origin)) return;
		event.preventDefault();
		if (isExternalUrl(target)) void shell.openExternal(target);
	});
	created.webContents.setWindowOpenHandler(({ url }) => {
		if (isExternalUrl(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	await created.loadURL(pageUrl);
	created.show();
	if (!SMOKE) return;
	const marker: unknown = await created.webContents.executeJavaScript(SMOKE_EXPRESSION);
	process.stdout.write(`desktop smoke: ${created.webContents.getURL()} ${JSON.stringify(marker)}\n`);
	await shutdownHost();
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
		onUnexpectedExit: ({ code, signal }) => {
			console.error(`desktop host exited (code ${String(code)}, signal ${String(signal)})`);
			app.quit();
		},
	});
	const pageUrl = await host.start();
	await openWindow(pageUrl);
}

function requestQuit(): void {
	if (quitReleased) return;
	void shutdownHost().finally(() => {
		quitReleased = true;
		app.quit();
	});
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
		console.error(error instanceof Error ? error.message : String(error));
		void shutdownHost().finally(() => {
			app.exit(1);
		});
	});
}
