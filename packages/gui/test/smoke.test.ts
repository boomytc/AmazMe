import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);

interface SmokeReport {
	readonly title: string;
	readonly boot: boolean;
	readonly name: string;
	readonly version: string;
	readonly mode: string;
	readonly transport: string;
}

function electronBinary(): string {
	const resolved: unknown = require("electron");
	if (typeof resolved !== "string" || resolved.length === 0) {
		throw new Error("electron did not resolve to a binary path");
	}
	return resolved;
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
		typeof record.transport === "string"
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

	test("opens the shared web host", async () => {
		scratch = await mkdtemp(join(tmpdir(), "amazme-gui-"));
		const packageRoot = fileURLToPath(new URL("..", import.meta.url));
		let stdout = "";
		let stderr = "";
		child = spawn(
			electronBinary(),
			["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "."],
			{
				cwd: packageRoot,
				detached: true,
				env: {
					...process.env,
					AMAZME_GUI_SMOKE: "1",
					AMAZME_GUI_NODE: process.execPath,
					AMAZME_GUI_CWD: scratch,
					AMAZME_SERVER_DIR: join(scratch, "server"),
					AMAZME_CODING_AGENT_DIR: join(scratch, "agent"),
					AMAZME_GUI_READY_TIMEOUT_MS: "120000",
				},
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
	}, 180_000);
});
