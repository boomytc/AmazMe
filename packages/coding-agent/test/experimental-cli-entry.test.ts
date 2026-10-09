import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";

// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runEntry(experimental: boolean, version = false) {
	const directory = mkdtempSync(join(tmpdir(), "pi-cli-boundary-"));
	tempDirs.push(directory);
	return spawnSync(
		process.execPath,
		[
			"--import",
			sourceResolverUrl,
			resolve(__dirname, "../src/cli.ts"),
			...(version ? ["--version"] : ["server", "--server-id", "invalid"]),
		],
		{
			cwd: directory,
			encoding: "utf8",
			timeout: 15_000,
			env: {
				...process.env,
				HOME: directory,
				USERPROFILE: directory,
				AMAZME_CODING_AGENT_DIR: join(directory, "agent"),
				AMAZME_OFFLINE: "1",
				AMAZME_EXPERIMENTAL: experimental ? "1" : "0",
			},
		},
	);
}

describe("formal CLI dispatch", () => {
	it("validates host commands without requiring experiment flags", () => {
		const result = runEntry(false);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain("Invalid --server-id");
	});
	it("keeps version metadata available without opening a host", () => {
		const result = runEntry(false, true);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(VERSION);
	});
	it("uses the same host dispatch when other experiments are enabled", () => {
		const result = runEntry(true);
		expect(result.status, result.stderr).toBe(1);
		expect(result.stderr).toContain("Invalid --server-id");
	});
});
