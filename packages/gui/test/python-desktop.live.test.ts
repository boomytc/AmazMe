import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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

interface PageTarget { readonly id: string; readonly webSocketDebuggerUrl: string }

async function pageTargets(port: number): Promise<PageTarget[]> {
	const list = await fetch(`http://127.0.0.1:${port}/json`);
	const targets = await list.json() as Array<{ id?: string; type?: string; webSocketDebuggerUrl?: string; url?: string }>;
	return targets.flatMap((item) => {
		if (item.type !== "page" || item.id === undefined || item.webSocketDebuggerUrl === undefined) return [];
		if (item.url !== undefined && !item.url.startsWith("http://127.0.0.1:")) return [];
		return [{ id: item.id, webSocketDebuggerUrl: item.webSocketDebuggerUrl }];
	});
}

function evaluateSocket(webSocketDebuggerUrl: string, expression: string): Promise<string> {
	const socket = new WebSocket(webSocketDebuggerUrl);
	return new Promise((resolve, reject) => {
		socket.addEventListener("open", () => {
			socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
		});
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: string }; exceptionDetails?: { text?: string } }; error?: { message?: string } };
			if (message.id !== 1) return;
			if (message.error) reject(new Error(message.error.message ?? "cdp"));
			else if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text ?? "cdp exception"));
			else resolve(message.result?.result?.value ?? "");
			socket.close();
		});
		socket.addEventListener("error", () => reject(new Error("cdp socket")));
	});
}

async function cdpEvaluate(port: number, expression: string): Promise<string> {
	const pages = await pageTargets(port);
	const page = pages[0];
	if (page === undefined) throw new Error(`no page target on ${port}`);
	return evaluateSocket(page.webSocketDebuggerUrl, expression);
}

const WINDOW_STATE = "JSON.stringify({href: location.href, connection: document.getElementById('connection')?.textContent || '', error: document.getElementById('error')?.textContent || '', loginHidden: document.getElementById('login')?.hidden === true})";

interface WindowState { href: string; connection: string; error: string; loginHidden: boolean; session: string; workspace: string }

function readWindowState(raw: string): WindowState {
	const parsed = JSON.parse(raw) as { href?: string; connection?: string; error?: string; loginHidden?: boolean };
	const href = parsed.href ?? "";
	const url = new URL(href);
	return {
		href,
		connection: parsed.connection ?? "",
		error: parsed.error ?? "",
		loginHidden: parsed.loginHidden === true,
		session: url.searchParams.get("session") ?? "",
		workspace: url.searchParams.get("workspace") ?? "",
	};
}

async function windowStates(port: number): Promise<Array<WindowState & { socket: string }>> {
	const pages = await pageTargets(port);
	const states: Array<WindowState & { socket: string }> = [];
	for (const page of pages) {
		states.push({ ...readWindowState(await evaluateSocket(page.webSocketDebuggerUrl, WINDOW_STATE)), socket: page.webSocketDebuggerUrl });
	}
	return states;
}

async function hostApi(origin: string, token: string, path: string, method: string, headers: Record<string, string>, body?: unknown): Promise<unknown> {
	const response = await fetch(new URL(path, origin), {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...headers,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path} ${response.status} ${text.slice(0, 180)}`);
	return text.length === 0 ? null : JSON.parse(text) as unknown;
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

	test("two windows name their own sessions and closing either one leaves the parked request", async () => {
		const scratch = createTempDir("amazme-python-desktop-");
		const workspace = join(scratch, "workspace");
		const agent = join(scratch, "agent");
		await mkdir(workspace);
		await mkdir(agent);
		await writeFile(join(agent, "settings.json"), JSON.stringify({ locale: "en" }));
		decoy = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
		const decoyPid = decoy.pid;
		expect(decoyPid).toBeTypeOf("number");
		const runs: Array<{ hostPid: number; sessions: [string, string]; workspace: string; status: string; cancelRequested: boolean; backendAliveAfterClose: boolean; backendDeadAfterQuit: boolean }> = [];

		for (const round of [1, 2]) {
			const debugPort = await freePort();
			let stdout = "";
			let stderr = "";
			const env = {
				...smokeEnvironment(scratch),
				AMAZME_GUI_SMOKE_HOLD: "1",
				AMAZME_PYTHON_BACKEND: BACKEND,
				AMAZME_GUI_USER_DATA_DIR: join(scratch, "user-data"),
				AMAZME_CODING_AGENT_DIR: agent,
				AMAZME_GUI_CWD: workspace,
			};
			const child = spawn(process.execPath, ["dist/start.js", `--remote-debugging-port=${debugPort}`, "--remote-debugging-address=127.0.0.1", "--remote-allow-origins=*"], {
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				detached: true,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.push(child);
			child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
			child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
			await waitFor(() => stdout.includes("desktop host pid:") && stdout.includes("desktop smoke: http://127.0.0.1:"), () => `round ${round} did not become ready\n${stdout}\n${stderr.slice(-4000)}`, 120_000);
			const hostPid = Number(/desktop host pid: (\d+)/.exec(stdout)?.[1]);
			const origin = /desktop smoke: (http:\/\/127\.0\.0\.1:\d+)\//.exec(stdout)?.[1] ?? "";
			expect(hostPid).toBeGreaterThan(0);
			expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			let first = "";
			await waitFor(async () => {
				try {
					const states = await windowStates(debugPort);
					first = JSON.stringify(states.map((item) => ({ session: item.session, workspace: item.workspace, connection: item.connection, error: item.error })));
					return states.length === 1 && /^[a-f0-9]{32}$/.test(states[0]?.session ?? "") && states[0]?.workspace === "primary" && states[0]?.connection === "已连接";
				} catch (error) {
					first = error instanceof Error ? error.message : "cdp";
					return false;
				}
			}, () => `round ${round} first window did not name a session: ${first}\n${stderr.slice(-1500)}`, 30_000);

			let openerErr = "";
			const opener = spawn(process.execPath, ["dist/start.js", "--amazme-new-window"], {
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				detached: true,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.push(opener);
			opener.stderr?.on("data", (chunk: Buffer) => { openerErr += chunk.toString(); });
			await new Promise<void>((resolve, reject) => {
				const finish = (code: number | null) => {
					if (code === 0) resolve();
					else reject(new Error(`round ${round} new window launch ${String(code)}\n${openerErr.slice(-1500)}\n${stdout}`));
				};
				if (opener.exitCode !== null) finish(opener.exitCode);
				else opener.once("exit", finish);
				setTimeout(() => reject(new Error(`round ${round} new window launch hung\n${openerErr.slice(-1500)}\n${stdout}`)), 20_000);
			});
			await waitFor(() => stdout.includes("desktop window requested"), () => `round ${round} did not request a second window\n${stdout}\n${stderr.slice(-1500)}`, 10_000);

			let both = "";
			await waitFor(async () => {
				try {
					const states = await windowStates(debugPort);
					both = JSON.stringify(states.map((item) => ({ session: item.session, workspace: item.workspace, connection: item.connection, error: item.error })));
					const ready = states.filter((item) => /^[a-f0-9]{32}$/.test(item.session) && item.workspace === "primary" && item.connection === "已连接");
					return ready.length === 2 && ready[0]?.session !== ready[1]?.session;
				} catch (error) {
					both = error instanceof Error ? error.message : "cdp";
					return false;
				}
			}, () => `round ${round} windows did not bind separate sessions: ${both}`, 30_000);
			const bound = (await windowStates(debugPort)).filter((item) => item.connection === "已连接");
			const sessionA = bound[0]?.session ?? "";
			const sessionB = bound[1]?.session ?? "";
			const socketB = bound[1]?.socket ?? "";
			expect(sessionA).toMatch(/^[a-f0-9]{32}$/);
			expect(sessionB).toMatch(/^[a-f0-9]{32}$/);
			expect(sessionA).not.toBe(sessionB);

			const token = readFileSync(join(scratch, "python-profile", "web.token"), "utf8").trim();
			const boot = asRecord(await hostApi(origin, token, "/api/v1/bootstrap", "GET", {}));
			const buildId = textField(boot, "build_id");
			const hostEpoch = boot.host_epoch;
			if (typeof hostEpoch !== "number") throw new Error("bootstrap is missing host_epoch");
			const fence = { "x-amazme-build": buildId, "x-amazme-epoch": String(hostEpoch) };
			const attachment = textField(asRecord(await hostApi(origin, token, `/api/v1/sessions/${sessionA}/attachments`, "POST", fence, {})), "attachment_id");
			const requestId = randomBytes(16).toString("hex");
			const parked = asReceipt(await hostApi(origin, token, `/api/v1/sessions/${sessionA}/submissions`, "POST", { ...fence, "x-amazme-attachment": attachment }, {
				request_id: requestId,
				text: "窗口仍在",
				not_before_ms: Date.now() + 3_600_000,
			}));
			expect(parked.status).toBe("waiting_time");
			expect(parked.cancelRequested).toBe(false);

			await evaluateSocket(socketB, "window.close()");
			await waitFor(async () => {
				try {
					const left = await windowStates(debugPort);
					return left.length === 1 && left[0]?.session === sessionA && left[0].connection === "已连接";
				} catch {
					return false;
				}
			}, () => `round ${round} the other window did not stay on its own session`, 15_000);
			const afterOther = asReceipt(await hostApi(origin, token, `/api/v1/sessions/${sessionA}/requests/${requestId}`, "GET", {}));
			expect(afterOther.status).toBe("waiting_time");
			expect(afterOther.cancelRequested).toBe(false);

			const own = (await windowStates(debugPort))[0];
			if (own === undefined) throw new Error("the owning window disappeared");
			await evaluateSocket(own.socket, "window.close()");
			await waitFor(async () => (await pageTargets(debugPort)).length === 0, () => `round ${round} the owning window stayed open`, 15_000);
			const afterOwn = asReceipt(await hostApi(origin, token, `/api/v1/sessions/${sessionA}/requests/${requestId}`, "GET", {}));
			expect(afterOwn.status).toBe("waiting_time");
			expect(afterOwn.cancelRequested).toBe(false);
			expect(alive(hostPid)).toBe(true);
			expect((await fetch(`${origin}/`)).status).toBe(200);

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
			runs.push({ hostPid, sessions: [sessionA, sessionB], workspace: "primary", status: afterOwn.status, cancelRequested: afterOwn.cancelRequested, backendAliveAfterClose: true, backendDeadAfterQuit: true });
		}
		expect(runs).toHaveLength(2);
		expect(new Set(runs.map((item) => item.hostPid)).size).toBe(2);
		expect(new Set(runs.flatMap((item) => item.sessions)).size).toBe(4);
		const manifest = JSON.parse(readFileSync(join(BACKEND, "..", "build.json"), "utf8")) as { build_id: string };
		await writeFile(join(REPOSITORY, "docs/python-backend-electron-windows.json"), JSON.stringify({
			executable: BACKEND,
			build_id: manifest.build_id,
			runs,
		}, null, 2));
	}, 420_000);
});

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null) throw new Error("response was not an object");
	return value as Record<string, unknown>;
}

function textField(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string" || field.length === 0) throw new Error(`response is missing ${key}`);
	return field;
}

function asReceipt(value: unknown): { status: string; cancelRequested: boolean } {
	const record = asRecord(value);
	if (typeof record.status !== "string" || typeof record.cancel_requested !== "boolean") throw new Error("receipt is missing status");
	return { status: record.status, cancelRequested: record.cancel_requested };
}
