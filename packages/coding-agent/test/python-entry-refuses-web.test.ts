import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir } from "./temp-dir.ts";

const cli = fileURLToPath(new URL("../dist/bundle/cli.js", import.meta.url));

describe("shipped CLI selects Python for product commands", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	it.each(["web", "server", "client"] as const)("requires Python before the command %s can listen", async (command) => {
		expect(existsSync(cli)).toBe(true);
		const directory = createTempDir("amazme-host-removed-");
		directories.push(directory);
		const profile = join(directory, "profile");
		const result = await runCli(directory, profile, [command, "--port", "0"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("python_backend_missing");
		expect(`${result.stdout}\n${result.stderr}`).not.toContain("Web: http");
	});

	it("refuses an internal host role instead of starting the old server", async () => {
		expect(existsSync(cli)).toBe(true);
		const directory = createTempDir("amazme-role-removed-");
		directories.push(directory);
		const profile = join(directory, "profile");
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const child = execFile(
				process.execPath,
				[cli],
				{
					cwd: directory,
					encoding: "utf8",
					timeout: 20_000,
					env: {
						...process.env,
						AMAZME_CODING_AGENT_DIR: profile,
						AMAZME_OFFLINE: "1",
					AMAZME_PYTHON_BACKEND: join(directory, "missing-backend"),
						__AMAZME_INTERNAL_SPAWN: "server",
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
		expect(result.stderr).toContain("internal_process_role_removed");
		expect(result.stdout).not.toContain("Web: http");
	});

	it("refuses --session before opening an old session database", async () => {
		expect(existsSync(cli)).toBe(true);
		const directory = createTempDir("amazme-session-removed-");
		directories.push(directory);
		const profile = join(directory, "profile");
		const sessionFile = join(directory, "not-a-session.log");
		writeFileSync(sessionFile, "{\"type\":\"event\"}\n");
		const result = await runCli(directory, profile, ["--session", sessionFile, "-p", "hi"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("invalid_session");
		expect(readFileSync(sessionFile, "utf8")).toBe("{\"type\":\"event\"}\n");
	});

	it.each(["import", "export"] as const)("requires Python for new-format %s", async (command) => {
		expect(existsSync(cli)).toBe(true);
		const directory = createTempDir("amazme-migration-removed-");
		directories.push(directory);
		const profile = join(directory, "profile");
		const result = await runCli(directory, profile, [command, join(directory, "missing.jsonl")]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("python_backend_missing");
	});
});

function runCli(directory: string, profile: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			process.execPath,
			[cli, ...args],
			{
				cwd: directory,
				encoding: "utf8",
				timeout: 20_000,
				env: {
					...process.env,
					AMAZME_CODING_AGENT_DIR: profile,
					AMAZME_OFFLINE: "1",
					AMAZME_PYTHON_BACKEND: join(directory, "missing-backend"),
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
}
