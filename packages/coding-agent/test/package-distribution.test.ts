import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

interface CodingAgentPackageJson {
	bin: { amazme: string };
	main: string;
	exports: {
		".": { import: string; types: string };
		"./client": { source: string };
		"./experimental/plugin": { source: string };
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

	// Regression for #9132: internal experimental entrypoints must not be published runtime exports.
	test("keeps experimental exports source-only", () => {
		expect(packageJson.exports["./client"]).toEqual({
			source: "./src/client/index.ts",
		});
		expect(packageJson.exports["./experimental/plugin"]).toEqual({
			source: "./src/experimental/plugin.ts",
		});
	});

	test("publishes the default interactive runtime reached by SDK main", () => {
		const directory = mkdtempSync(join(tmpdir(), "amazme-distribution-"));
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
			for (const name of [
				"interactive",
				"runtime",
				"harness-setup",
				"tui",
				"sessions",
				"session-surface",
				"conversation-view",
			]) {
				expect(paths).toContain(`dist/durable/${name}.js`);
			}
			expect(paths.some((path) => path.startsWith("dist/experimental/"))).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
