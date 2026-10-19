import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { electronBinary, smokeEnvironment } from "./smoke-support.ts";
import { createTempDir } from "./temp-dir.ts";

interface SmokeReport {
	readonly title: string;
	readonly boot: boolean;
	readonly name: string;
	readonly version: string;
	readonly mode: string;
	readonly transport: string;
	readonly language: string;
	readonly desktopLocale: string;
}

function isSmokeReport(value: unknown): value is SmokeReport {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.title === "string" &&
		typeof record.boot === "boolean" &&
		typeof record.name === "string" &&
		typeof record.version === "string" &&
		typeof record.mode === "string" &&
		typeof record.transport === "string" &&
		typeof record.language === "string" &&
		typeof record.desktopLocale === "string"
	);
}

function parseSmokeLine(line: string): { url: string; report: SmokeReport } {
	const match = /^desktop smoke: (\S+) (\{.*)$/.exec(line);
	const url = match?.[1];
	const json = match?.[2];
	if (url === undefined || json === undefined) throw new Error(`unreadable smoke line: ${line}`);
	const parsed: unknown = JSON.parse(json) as unknown;
	if (!isSmokeReport(parsed)) throw new Error(`smoke line is not the boot marker: ${line}`);
	return { url, report: parsed };
}

describe("electron window", () => {
	let child: ChildProcess | undefined;
	let scratch: string | undefined;

	afterEach(async () => {
		const pid = child?.pid;
		if (pid !== undefined) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// The smoke process already exited.
			}
		}
		child = undefined;
		if (scratch !== undefined) {
			await rm(scratch, { recursive: true, force: true });
			scratch = undefined;
		}
	});

	async function launch(entry = ".", hold = false): Promise<string> {
		if (scratch === undefined) throw new Error("Smoke directory is not prepared");
		const packageRoot = fileURLToPath(new URL("..", import.meta.url));
		let stdout = "";
		let stderr = "";
		child = spawn(
			electronBinary(),
			["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", entry],
			{
				cwd: packageRoot,
				detached: true,
				env: { ...smokeEnvironment(scratch), ...(hold ? { AMAZME_GUI_SMOKE_HOLD: "1" } : {}) },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`electron smoke timed out\nstdout:\n${stdout}\nstderr:\n${stderr.slice(-8000)}`));
			}, 150_000);
			child?.once("exit", (code) => {
				clearTimeout(timer);
				resolve(code);
			});
			child?.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
		if (exitCode !== 0) {
			throw new Error(
				`electron smoke exited ${String(exitCode)}\nstdout:\n${stdout}\nstderr:\n${stderr.slice(-8000)}`,
			);
		}
		return stdout;
	}

	test("a cancelled native directory picker returns no paths through the real preload IPC", async () => {
		scratch = createTempDir("amazme-gui-picker-");
		const fixture = join(scratch, "picker-fixture.mjs");
		await writeFile(fixture, `
import { app, dialog } from "electron";
const original = dialog.showOpenDialog;
let calls = 0;
dialog.showOpenDialog = async () => {
  calls += 1;
  return { canceled: calls === 1, filePaths: ["/selected-directory"] };
};
app.on("browser-window-created", (_event, window) => {
  window.webContents.once("did-finish-load", async () => {
    try {
      const cancelled = await window.webContents.executeJavaScript("window.amazmeDesktop.pickDirectories()");
      const selected = await window.webContents.executeJavaScript("window.amazmeDesktop.pickDirectories()");
      process.stdout.write("directory picker smoke: " + JSON.stringify({ cancelled, selected, calls }) + "\\n");
      app.quit();
    } catch (error) {
      console.error(error);
      app.exit(1);
    } finally {
      dialog.showOpenDialog = original;
    }
  });
});
await import(${JSON.stringify(new URL("../dist/main.js", import.meta.url).href)});
`);
		const output = await launch(fixture, true);
		const line = output.split("\n").find(value => value.startsWith("directory picker smoke: "));
		expect(line).toBeDefined();
		expect(JSON.parse(line!.slice("directory picker smoke: ".length))).toEqual({
			cancelled: [], selected: ["/selected-directory"], calls: 2,
		});
	}, 180_000);

	test("desktop font shortcuts preserve rapid increments and reset sizes without changing fonts or page zoom", async () => {
		scratch = createTempDir("amazme-gui-fonts-");
		await mkdir(join(scratch, "agent"));
		await writeFile(join(scratch, "agent", "settings.json"), JSON.stringify({
			locale: "en",
			typography: { textFont: "Arial", codeFont: "Courier New", terminalFont: "Menlo" },
		}));
		const fixture = join(scratch, "font-fixture.mjs");
		await writeFile(fixture, `
import assert from "node:assert/strict";
import { app, Menu } from "electron";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const expression =
  "(() => {" +
  " const style = document.documentElement.style;" +
  " return {" +
  "  connected: document.getElementById('connection-status')?.dataset.state === 'connected'," +
  "  desktop: typeof window.amazmeDesktop?.pickDirectories === 'function'," +
  "  sizes: ['--content-font-size', '--code-font-size', '--terminal-font-size'].map(name => style.getPropertyValue(name).trim())," +
  "  families: ['--font-content', '--font-code', '--font-terminal'].map(name => style.getPropertyValue(name).trim())" +
  " };" +
  "})()";
app.on("browser-window-created", (_event, window) => {
  window.webContents.once("did-finish-load", async () => {
    try {
      const menu = Menu.getApplicationMenu();
      assert.ok(menu, "The desktop retains its application menu");
      const menuRoles = items => items.flatMap(item => [item.role?.toLowerCase(), ...menuRoles(item.submenu?.items ?? [])]).filter(Boolean);
      const roles = menuRoles(menu.items);
      assert.ok(roles.includes("editmenu") && roles.includes("windowmenu"), "Standard Edit and Window menus remain available");
      assert.ok(roles.includes("copy") && roles.includes("paste") && roles.includes("minimize"), "Standard edit and window actions remain available");
      assert.ok(!roles.some(role => ["zoomin", "zoomout", "resetzoom"].includes(role)), "Native page zoom roles must not intercept font shortcuts");
      const snapshots = [];
      async function waitForSizes(step, sizes) {
        const deadline = Date.now() + 30_000;
        let latest;
        do {
          latest = { ...await window.webContents.executeJavaScript(expression), zoomFactor: window.webContents.getZoomFactor() };
          assert.equal(latest.zoomFactor, 1, step + " must not change the browser zoom");
          if (latest.connected && latest.desktop && JSON.stringify(latest.sizes) === JSON.stringify(sizes)) {
            snapshots.push({ step, ...latest });
            return;
          }
          await pause(25);
        } while (Date.now() < deadline);
        throw new Error(step + " did not reach expected typography: " + JSON.stringify(latest));
      }
      await waitForSizes("initial", ["15px", "13px", "12px"]);
      // CDP reaches the real renderer without requiring OS foreground focus in a test runner.
      // Menu assertions above independently check that native page-zoom roles are absent.
      window.webContents.debugger.attach("1.3");
      const modifiers = process.platform === "darwin" ? 4 : 2;
      async function shortcut(key) {
        const code = { "=": "Equal", "-": "Minus", "0": "Digit0" }[key];
        const windowsVirtualKeyCode = { "=": 187, "-": 189, "0": 48 }[key];
        for (const type of ["keyDown", "keyUp"]) {
          await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode, modifiers });
        }
      }
      await shortcut("=");
      await waitForSizes("increase", ["16px", "14px", "13px"]);
      // Enqueue both renderer gestures before waiting for either Host response.
      await Promise.all([shortcut("="), shortcut("=")]);
      await waitForSizes("rapid increase", ["18px", "16px", "15px"]);
      await shortcut("-");
      await waitForSizes("decrease", ["17px", "15px", "14px"]);
      await shortcut("0");
      await waitForSizes("reset", ["15px", "13px", "12px"]);
      process.stdout.write("font shortcut smoke: " + JSON.stringify(snapshots) + "\\n");
      app.quit();
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
});
await import(${JSON.stringify(new URL("../dist/main.js", import.meta.url).href)});
`);
		const output = await launch(fixture, true);
		const line = output.split("\n").find(value => value.startsWith("font shortcut smoke: "));
		expect(line).toBeDefined();
		const expected = [
			{ step: "initial", sizes: ["15px", "13px", "12px"] },
			{ step: "increase", sizes: ["16px", "14px", "13px"] },
			{ step: "rapid increase", sizes: ["18px", "16px", "15px"] },
			{ step: "decrease", sizes: ["17px", "15px", "14px"] },
			{ step: "reset", sizes: ["15px", "13px", "12px"] },
		].map(snapshot => ({
			...snapshot,
			connected: true,
			desktop: true,
			families: ['"Arial", var(--font-sans)', '"Courier New", var(--font-mono)', '"Menlo", var(--font-mono)'],
			zoomFactor: 1,
		}));
		expect(JSON.parse(line!.slice("font shortcut smoke: ".length))).toEqual(expected);
	}, 180_000);

	test.each(["en", "zh", "auto"] as const)("opens the shared web host with application language %s", async (locale) => {
		scratch = createTempDir("amazme-gui-");
		await mkdir(join(scratch, "agent"));
		await writeFile(join(scratch, "agent", "settings.json"), JSON.stringify({ locale }));
		const stdout = await launch();
		const line = stdout.split("\n").find((entry) => entry.startsWith("desktop smoke: "));
		expect(line).toBeDefined();
		const smoke = parseSmokeLine(line ?? "");
		expect(smoke.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
		expect(smoke.report.boot).toBe(true);
		expect(smoke.report.name).toBe("AmazMe");
		expect(smoke.report.mode).toBe("installed");
		// The shared page sets the document title from the boot manifest.
		expect(smoke.report.title).toBe(`${smoke.report.name} ${smoke.report.version}`);
		expect(smoke.report.transport).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/amazme$/);
		expect(smoke.report.language.split("-")[0]).toBe(smoke.report.desktopLocale);
		if (locale !== "auto") expect(smoke.report.desktopLocale).toBe(locale);
	}, 180_000);
});
