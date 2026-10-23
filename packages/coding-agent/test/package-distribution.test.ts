import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createTempDir } from "./temp-dir.ts";

interface CodingAgentPackageJson {
	bin: { amazme: string };
	main: string;
	exports: {
		".": { import: string; types: string };
		"./client": { source: string; types: string; import: string };
		"./host/plugin": { source: string; types: string; import: string };
		"./rpc-entry": { import: string };
	};
}

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

describe("package distribution entrypoints", () => {
	test("uses the bundle for executables and modular output for libraries", () => {
		expect(packageJson.bin.amazme).toBe("dist/bundle/cli.js");
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.exports["."].import).toBe("./dist/index.js");
		expect(packageJson.exports["./rpc-entry"].import).toBe("./dist/bundle/rpc-entry.js");
	});

	test("publishes compiled client and host plugin exports", () => {
		expect(packageJson.exports["./client"]).toEqual({
			source: "./src/client/index.ts",
			types: "./dist/client/index.d.ts",
			import: "./dist/client/index.js",
		});
		expect(packageJson.exports["./host/plugin"]).toEqual({
			source: "./src/host/plugin.ts",
			types: "./dist/host/plugin.d.ts",
			import: "./dist/host/plugin.js",
		});
	});

	test("ships the durable modules the SDK still compiles and omits the removed runtime entry", () => {
		const directory = createTempDir("amazme-distribution-");
		try {
			const npmCli = process.env.npm_execpath;
			if (!npmCli) throw new Error("Run distribution checks through npm test");
			const packed: { files: { path: string }[] }[] = JSON.parse(
				execFileSync(
					process.execPath,
					[
						npmCli,
						"pack",
						"--ignore-scripts",
						"--json",
						"--cache",
						join(directory, "cache"),
						"--pack-destination",
						directory,
					],
					{
						cwd: fileURLToPath(new URL("..", import.meta.url)),
						encoding: "utf8",
						timeout: 30_000,
					},
				),
			);
			const paths = packed[0].files.map((file) => file.path);
			for (const name of ["runtime", "harness-setup", "sessions", "session-surface", "conversation-view"]) {
				expect(paths).toContain(`dist/durable/${name}.js`);
			}
			for (const name of ["interactive", "tui", "print", "import", "json-events", "mcp-menu", "screen-restore"]) {
				expect(paths).not.toContain(`dist/durable/${name}.js`);
			}
			expect(paths).not.toContain("dist/host/commands.js");
			expect(paths).not.toContain("dist/modes/rpc/durable-rpc.js");
			expect(paths.some((path) => path.startsWith("dist/experimental/"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
