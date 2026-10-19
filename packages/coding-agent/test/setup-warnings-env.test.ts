import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
// Not imported: the setup file runs only as vitest's setup file here, and as `node --import` below.
const setupFileUrl = pathToFileURL(join(import.meta.dirname, "setup-warnings-env.ts")).href;
const EMIT_WARNING = 'process.emitWarning("setup-warnings-env probe", "ExperimentalWarning")';
const WARNING_TEXT = "ExperimentalWarning: setup-warnings-env probe";
/** How a shell silences Node's warnings. */
const SILENCED = { NODE_NO_WARNINGS: "1", NODE_OPTIONS: "--no-warnings" };
const SWITCHES = /--no[-_]warnings|--no[-_]deprecation|--disable[-_]warning|--redirect[-_]warnings/u;

/** Run `script` in a Node process started with `env` (on top of this one's) and, optionally, the setup file. */
function node(script: string, env: NodeJS.ProcessEnv, setup: boolean) {
	return execFileAsync(
		process.execPath,
		[...(setup ? ["--import", setupFileUrl] : []), "--input-type=module", "-e", script],
		{ encoding: "utf8", env: { ...process.env, ...env } },
	);
}

describe("vitest setup: warnings stay visible to child processes", () => {
	test("the setup file has run: this worker's environment carries no warning switches", () => {
		expect(process.env.NODE_NO_WARNINGS).toBeUndefined();
		expect(process.env.NODE_REDIRECT_WARNINGS).toBeUndefined();
		expect(process.env.NODE_OPTIONS ?? "").not.toMatch(SWITCHES);
	});

	test("a child that inherits the environment prints warnings", async () => {
		const { stderr } = await execFileAsync(process.execPath, ["-e", EMIT_WARNING], { encoding: "utf8" });
		expect(stderr).toContain(WARNING_TEXT);
	});

	test("a process started silenced shows its children's warnings once the setup file has run", async () => {
		// A stand-in for a vitest worker launched from a silenced shell: it spawns a child that inherits its environment.
		const worker = `const { execFileSync } = await import("node:child_process");
			execFileSync(process.execPath, ["-e", ${JSON.stringify(EMIT_WARNING)}], { stdio: ["ignore", "ignore", "inherit"] });`;
		expect((await node(worker, SILENCED, false)).stderr).toBe("");
		expect((await node(worker, SILENCED, true)).stderr).toContain(WARNING_TEXT);
	});

	test.each([
		[
			"--max-old-space-size=4096 --no-warnings --disable-warning=ExperimentalWarning --enable-source-maps",
			"--max-old-space-size=4096 --enable-source-maps",
		],
		["--disable-warning ExperimentalWarning --redirect-warnings=/dev/null --enable-source-maps", "--enable-source-maps"],
		["--no_warnings --no-deprecation", undefined],
	])("strips the silencing switches from NODE_OPTIONS=%j and keeps the other options", async (options, expected) => {
		const report = "process.stdout.write(JSON.stringify([process.env.NODE_NO_WARNINGS, process.env.NODE_REDIRECT_WARNINGS, process.env.NODE_OPTIONS, process.env.SETUP_PROBE]))";
		const env = { NODE_NO_WARNINGS: "1", NODE_REDIRECT_WARNINGS: "/dev/null", NODE_OPTIONS: options, SETUP_PROBE: "kept" };
		const { stdout } = await node(report, env, true);
		expect(JSON.parse(stdout)).toEqual([null, null, expected ?? null, "kept"]);
	});
});

describe("tests leave warning visibility to the setup file", () => {
	const testRoot = import.meta.dirname;
	/** The setup file, and this file, which has to name the variable to test it. */
	const allowed = new Set(["setup-warnings-env.ts", "setup-warnings-env.test.ts"]);

	function sources(directory: string): string[] {
		return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
			return /\.(?:[cm]?[jt]s|tsx|py)$/u.test(entry.name) ? [path] : [];
		});
	}

	test("no test sets NODE_NO_WARNINGS itself", () => {
		const offenders = sources(testRoot)
			.map((path) => relative(testRoot, path))
			.filter((file) => !allowed.has(file))
			.filter((file) => readFileSync(join(testRoot, file), "utf8").includes("NODE_NO_WARNINGS"));
		expect(offenders).toEqual([]);
	});
});
