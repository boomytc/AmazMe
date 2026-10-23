import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir } from "./temp-dir.ts";

const cli = fileURLToPath(new URL("../dist/bundle/cli.js", import.meta.url));

describe("shipped CLI ignores the old durable switch", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	it("prints python_backend_missing for --print when AMAZME_DURABLE_TUI=1", async () => {
		const directory = createTempDir("amazme-python-entry-");
		directories.push(directory);
		const profile = join(directory, "profile");
		const missing = join(directory, "missing-backend");
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const child = execFile(
				process.execPath,
				[cli, "--offline", "--print", "hello"],
				{
					cwd: directory,
					encoding: "utf8",
					timeout: 20_000,
					env: {
						...process.env,
						AMAZME_CODING_AGENT_DIR: profile,
						AMAZME_DURABLE_TUI: "1",
						AMAZME_OFFLINE: "1",
						AMAZME_PYTHON_BACKEND: missing,
					},
				},
				(error, stdout, stderr) => {
					const exitCode = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
					if (error && !("code" in error)) reject(error);
					else resolve({ code: exitCode, stdout, stderr });
				},
			);
			child.stdin?.end();
		});
		expect(result.code).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toContain("python_backend_missing");
		expect(result.stdout).not.toContain("AmazMe v");
	});
});
