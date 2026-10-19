import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";
import { childProcessEnv, withoutWarningFlags } from "./child-process-env.ts";

const execFileAsync = promisify(execFile);

describe("childProcessEnv", () => {
	test("drops every inherited way to silence or redirect warnings and keeps the rest", () => {
		vi.stubEnv("NODE_NO_WARNINGS", "1");
		vi.stubEnv("NODE_REDIRECT_WARNINGS", "/tmp/warnings.log");
		vi.stubEnv("NODE_OPTIONS", "--max-old-space-size=4096 --no-warnings --disable-warning=ExperimentalWarning");
		vi.stubEnv("AMAZME_CHILD_ENV_PROBE", "kept");

		const env = childProcessEnv({ AMAZME_OFFLINE: "1", AMAZME_CHILD_ENV_DROPPED: undefined });

		expect(env.NODE_NO_WARNINGS).toBeUndefined();
		expect(env.NODE_REDIRECT_WARNINGS).toBeUndefined();
		expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
		expect(env.AMAZME_CHILD_ENV_PROBE).toBe("kept");
		expect(env.AMAZME_OFFLINE).toBe("1");
		expect("AMAZME_CHILD_ENV_DROPPED" in env).toBe(false);
	});

	test("an override cannot bring the silencing back", () => {
		const env = childProcessEnv({ NODE_NO_WARNINGS: "1", NODE_OPTIONS: "--no-deprecation" });
		expect(env.NODE_NO_WARNINGS).toBeUndefined();
		expect("NODE_OPTIONS" in env).toBe(false);
	});

	test("strips each silencing spelling from NODE_OPTIONS", () => {
		expect(withoutWarningFlags("--no-warnings")).toBe("");
		expect(withoutWarningFlags("--no_warnings --no-deprecation")).toBe("");
		expect(withoutWarningFlags("--disable-warning ExperimentalWarning --enable-source-maps")).toBe("--enable-source-maps");
		expect(withoutWarningFlags("--redirect-warnings=/tmp/w.log --inspect=0")).toBe("--inspect=0");
		expect(withoutWarningFlags("  --require ./a.js   --no-warnings ")).toBe("--require ./a.js");
	});

	test("a child spawned with it prints the warning a shell's NODE_NO_WARNINGS and NODE_OPTIONS would hide", async () => {
		vi.stubEnv("NODE_NO_WARNINGS", "1");
		vi.stubEnv("NODE_OPTIONS", "--no-warnings");
		const probe = ["-e", 'process.emitWarning("child-process-env probe", "ExperimentalWarning")'];

		const hidden = await execFileAsync(process.execPath, probe, { encoding: "utf8", env: process.env });
		expect(hidden.stderr).toBe("");

		const shown = await execFileAsync(process.execPath, probe, { encoding: "utf8", env: childProcessEnv() });
		expect(shown.stderr).toContain("ExperimentalWarning: child-process-env probe");
	});
});

/** A test that starts a child process: it imports node:child_process. */
const CHILD_PROCESS_IMPORT = /from\s+["'](?:node:)?child_process["']/u;
/** An assertion on stderr text: `expect(stderr)`, `expect(result.stderr)`, `expect(stderr.join(""))`, `expect({ code, stderr })`. */
const STDERR_ASSERTION = /expect\(\s*(?:\{[^}]*\bstderr\b[^}]*\}|[\w.]*\bstderr\b(?:\.join\([^)]*\))?(?:\(\))?)\s*\)/u;
const HELPER_IMPORT = /from\s+["'](?:\.\.?\/)+(?:[\w-]+\/)*child-process-env\.ts["']/u;
const testRoot = import.meta.dirname;
const HELPER_FILES = new Set(["child-process-env.ts", "child-process-env.test.ts"]);

function testSources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" ? [] : testSources(path);
		return /\.(?:ts|mts|mjs|js)$/u.test(entry.name) ? [path] : [];
	});
}

describe("tests that assert on a child process's stderr", () => {
	const sources = testSources(testRoot)
		.filter((path) => !HELPER_FILES.has(relative(testRoot, path)))
		.map((path) => ({ file: relative(testRoot, path), text: readFileSync(path, "utf8") }));

	test("spawn it with childProcessEnv, so a shell's NODE_NO_WARNINGS cannot hide a warning", () => {
		const covered = sources.filter(({ text }) => CHILD_PROCESS_IMPORT.test(text) && STDERR_ASSERTION.test(text));
		// The scan must keep finding the known ones; an empty list would mean the patterns rotted.
		expect(covered.map(({ file }) => file)).toContain("session-file-invalid.test.ts");
		expect(covered.filter(({ text }) => !HELPER_IMPORT.test(text)).map(({ file }) => file)).toEqual([]);
	});

	test("never set NODE_NO_WARNINGS themselves", () => {
		expect(sources.filter(({ text }) => /\bNODE_NO_WARNINGS\b/u.test(text)).map(({ file }) => file)).toEqual([]);
	});
});
