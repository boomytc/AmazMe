import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { alive, processRows, smokeEnvironment, waitFor } from "./smoke-support.ts";
import { createTempDir } from "./temp-dir.ts";

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const BACKEND = join(readFileSync(join(REPOSITORY, ".artifacts/python-backend-electron/latest-bundle"), "utf8").trim(), "amazme-backend");

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("no port"));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

async function cdpEvaluate(port: number, expression: string): Promise<string> {
	const list = await fetch(`http://127.0.0.1:${port}/json`);
	const targets = await list.json() as Array<{ type?: string; webSocketDebuggerUrl?: string; url?: string }>;
	const page = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
	if (page?.webSocketDebuggerUrl === undefined) throw new Error(`no page target on ${port}`);
	const socket = new WebSocket(page.webSocketDebuggerUrl);
	const result = await new Promise<string>((resolve, reject) => {
		socket.addEventListener("open", () => {
			socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
		});
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: string } }; error?: { message?: string } };
			if (message.id !== 1) return;
			if (message.error) reject(new Error(message.error.message ?? "cdp"));
			else resolve(message.result?.result?.value ?? "");
			socket.close();
		});
		socket.addEventListener("error", () => reject(new Error("cdp socket")));
	});
	return result;
}

describe("electron launches the packaged python backend", () => {
	const children: ChildProcess[] = [];
	let decoy: ChildProcess | undefined;

	afterEach(() => {
		for (const child of children) {
			if (child.pid !== undefined) {
				try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
			}
		}
		children.length = 0;
		spawn("pkill", ["-f", "amazme-python-desktop-"], { stdio: "ignore" }).unref();
		if (decoy?.pid !== undefined) {
			try { process.kill(decoy.pid, "SIGKILL"); } catch { /* already exited */ }
		}
		decoy = undefined;
	});

	test("pairs twice, keeps the backend after the window closes, and quits only that service", async () => {
		const scratch = createTempDir("amazme-python-desktop-");
		const workspace = join(scratch, "workspace");
		const agent = join(scratch, "agent");
		await mkdir(workspace);
		await mkdir(agent);
		await writeFile(join(agent, "settings.json"), JSON.stringify({ locale: "en" }));
		decoy = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
		const decoyPid = decoy.pid;
		expect(decoyPid).toBeTypeOf("number");
		const runs: Array<{ hostPid: number; page: string; loginHidden: boolean; backendAliveAfterClose: boolean; backendDeadAfterQuit: boolean }> = [];

		for (const round of [1, 2]) {
			const debugPort = await freePort();
			let stdout = "";
			let stderr = "";
			const child = spawn(process.execPath, ["dist/start.js", `--remote-debugging-port=${debugPort}`, "--remote-debugging-address=127.0.0.1", "--remote-allow-origins=*"], {
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				detached: true,
				env: {
					...smokeEnvironment(scratch),
					AMAZME_GUI_SMOKE_HOLD: "1",
					AMAZME_PYTHON_BACKEND: BACKEND,
					AMAZME_GUI_USER_DATA_DIR: join(scratch, "user-data"),
					AMAZME_CODING_AGENT_DIR: agent,
					AMAZME_GUI_CWD: workspace,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.push(child);
			child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
			child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
			await waitFor(() => stdout.includes("desktop host pid:") && stdout.includes("desktop smoke: http://127.0.0.1:"), () => `round ${round} did not become ready\n${stdout}\n${stderr.slice(-4000)}`, 120_000);
			const hostPid = Number(/desktop host pid: (\d+)/.exec(stdout)?.[1]);
			const page = /desktop smoke: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout)?.[1] ?? "";
			expect(hostPid).toBeGreaterThan(0);
			expect(page).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
			let loginHidden = false;
			let connection = "";
			await waitFor(async () => {
				try {
					const raw = await cdpEvaluate(debugPort, "JSON.stringify({loginHidden: document.getElementById('login')?.hidden === true, connection: document.getElementById('connection')?.textContent || '', error: document.getElementById('error')?.textContent || '', sessions: document.getElementById('sessions')?.textContent || ''})");
					const parsed = JSON.parse(raw) as { loginHidden: boolean; connection: string; error: string; sessions: string };
					loginHidden = parsed.loginHidden;
					connection = raw;
					return loginHidden;
				} catch (error) {
					connection = error instanceof Error ? error.message : "cdp";
					return false;
				}
			}, () => `round ${round} pairing did not finish: ${connection}\n${stderr.slice(-1500)}`, 30_000);
			await cdpEvaluate(debugPort, "window.close()");
			await new Promise<void>((resolve) => setTimeout(resolve, 1500));
			expect(alive(hostPid)).toBe(true);
			expect(alive(child.pid ?? -1)).toBe(true);
			const health = await fetch(`${page}/`);
			expect(health.status).toBe(200);
			const quitLog: string[] = [];
			await new Promise<void>((resolve, reject) => {
				child.once("exit", (code) => { if (code === 0) resolve(); else reject(new Error(`round ${round} quit ${code}\n${stderr.slice(-2000)}`)); });
				const quitter = spawn("/usr/bin/osascript", ["-e", 'tell application "AmazMe" to quit'], { stdio: ["ignore", "pipe", "pipe"] });
				quitter.stdout?.on("data", (chunk: Buffer) => { quitLog.push(chunk.toString()); });
				quitter.stderr?.on("data", (chunk: Buffer) => { quitLog.push(chunk.toString()); });
				setTimeout(() => reject(new Error(`round ${round} did not quit\n${quitLog.join("")}\n${stdout}\n${stderr.slice(-2000)}`)), 25_000);
			});
			await waitFor(() => !alive(hostPid), () => `round ${round} backend ${hostPid} still alive`, 20_000);
			expect(alive(decoyPid ?? -1)).toBe(true);
			const rows = await processRows();
			expect(rows.some((row) => row.pid === hostPid)).toBe(false);
			runs.push({ hostPid, page, loginHidden, backendAliveAfterClose: true, backendDeadAfterQuit: true });
		}
		expect(runs).toHaveLength(2);
		expect(new Set(runs.map((item) => item.hostPid)).size).toBe(2);
		const manifest = JSON.parse(readFileSync(join(BACKEND, "..", "build.json"), "utf8")) as { build_id: string };
		await writeFile(join(REPOSITORY, "docs/python-backend-electron-launch.json"), JSON.stringify({
			executable: BACKEND,
			build_id: manifest.build_id,
			runs,
		}, null, 2));
	}, 300_000);
});
