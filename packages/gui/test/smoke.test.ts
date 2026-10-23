import { type ChildProcess, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { electronBinary, smokeEnvironment } from "./smoke-support.ts";
import { createTempDir } from "./temp-dir.ts";

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

	test("refuses to start when the packaged Python backend is missing", async () => {
		scratch = createTempDir("amazme-gui-");
		const packageRoot = fileURLToPath(new URL("..", import.meta.url));
		let stdout = "";
		let stderr = "";
		child = spawn(electronBinary(), ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "."], {
			cwd: packageRoot,
			detached: true,
			env: smokeEnvironment(scratch),
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`electron smoke timed out\nstdout:\n${stdout}\nstderr:\n${stderr.slice(-8000)}`));
			}, 60_000);
			child?.once("exit", (code) => {
				clearTimeout(timer);
				resolve(code);
			});
			child?.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
		expect(exitCode).not.toBe(0);
		expect(`${stdout}\n${stderr}`).toContain("桌面需要包内的 Python 后端");
		expect(stdout).not.toContain("desktop smoke:");
	}, 70_000);
});
