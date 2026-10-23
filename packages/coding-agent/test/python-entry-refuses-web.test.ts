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

	it("exits before listening when the command is web", async () => {
		expect(existsSync(cli)).toBe(true);
		const directory = createTempDir("amazme-web-removed-");
		directories.push(directory);
		const profile = join(directory, "profile");
		const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const child = execFile(
				process.execPath,
				[cli, "web", "--port", "0"],
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
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("old_web_host_removed");
		expect(`${result.stdout}\n${result.stderr}`).not.toContain("Web: http");
	});
});
