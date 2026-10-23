import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir } from "./temp-dir.ts";

const cli = fileURLToPath(new URL("../dist/bundle/cli.js", import.meta.url));

describe("shipped CLI does not start the old web host", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	it.each(["web", "server", "client"] as const)("exits before listening when the command is %s", async (command) => {
		expect(existsSync(cli)).toBe(true);
		const directory = createTempDir("amazme-host-removed-");
		directories.push(directory);
		const profile = join(directory, "profile");
		const result = await runCli(directory, profile, [command, "--port", "0"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("old_web_host_removed");
		expect(`${result.stdout}\n${result.stderr}`).not.toContain("Web: http");
	});

	it.each(["import", "export"] as const)("refuses old session %s without reading a session file", async (command) => {
		expect(existsSync(cli)).toBe(true);
		const directory = createTempDir("amazme-migration-removed-");
		directories.push(directory);
		const profile = join(directory, "profile");
		const result = await runCli(directory, profile, [command, join(directory, "missing.jsonl")]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("old_session_migration_removed");
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
