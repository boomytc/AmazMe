import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { desktopBuildFingerprint, desktopBuildIsCurrent, writeDesktopBuildState } from "./dev-desktop.mjs";

const launcher = fileURLToPath(new URL("./dev-desktop.mjs", import.meta.url));
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryBackend = join(root, "backend", ".venv",
	process.platform === "win32" ? "Scripts" : "bin",
	process.platform === "win32" ? "amazme-backend.exe" : "amazme-backend");

async function launch(backend, failBuild = false) {
	const directory = await mkdtemp(join(tmpdir(), "amazme-dev-desktop-"));
	try {
		const log = join(directory, "calls.jsonl");
		const cli = join(directory, "npm.mjs");
		const state = join(directory, "build-state");
		await writeFile(cli, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), backend: process.env.AMAZME_PYTHON_BACKEND }) + "\\n");\n${failBuild ? "if (process.argv.slice(2).includes(\"build\")) process.exit(2);" : ""}`);
		const result = await new Promise(resolve => execFile(process.execPath, [launcher], {
			cwd: root, timeout: 10000, env: { ...process.env, npm_execpath: cli, AMAZME_PYTHON_BACKEND: backend, AMAZME_DEV_DESKTOP_BUILD_STATE: state },
		}, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
		if (!failBuild) assert.equal(result.error, null, result.stderr);
		const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
		return { result, calls, state };
	} finally { await rm(directory, { recursive: true, force: true }); }
}

test("the desktop launcher uses the repository backend and preserves the build and start sequence", async () => {
	const { calls } = await launch("");
	assert.deepEqual(calls.map(call => call.args), [
		["run", "build", "--workspace", "@amazme/web"],
		["run", "build", "--workspace", "@amazme/gui"],
		["start", "--workspace", "@amazme/gui"],
	]);
	assert.equal(calls.at(-1).backend, repositoryBackend);
});

test("the desktop launcher preserves an absolute backend and resolves a relative override from the repository", async () => {
	assert.equal((await launch("/custom/amazme-backend")).calls.at(-1).backend, "/custom/amazme-backend");
	assert.equal((await launch("custom/amazme-backend")).calls.at(-1).backend, resolve(root, "custom/amazme-backend"));
});

test("a failed dependency build does not start the desktop or write a valid cache", async () => {
	const { result, calls, state } = await launch("", true);
	assert.equal(result.error.code, 1);
	assert.deepEqual(calls.map(call => call.args), [["run", "build", "--workspace", "@amazme/web"]]);
	assert.equal(existsSync(state), false);
});

test("the build cache requires output and changes with source and installed dependencies", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "amazme-dev-build-"));
	try {
		const directory = join(fixtureRoot, "packages", "gui");
		const source = join(directory, "src", "index.ts");
		const installedLock = join(fixtureRoot, "node_modules", ".package-lock.json");
		await mkdir(join(directory, "src"), { recursive: true });
		await mkdir(join(fixtureRoot, "node_modules"), { recursive: true });
		await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@amazme/gui", scripts: { build: "build" } }));
		await writeFile(source, "export {};\n");
		await writeFile(installedLock, "{}\n");
		const plan = [{ name: "@amazme/gui", script: "build" }];
		const state = join(fixtureRoot, ".artifacts", "build-state");
		const output = join(directory, "dist", "main.js");
		const initial = desktopBuildFingerprint(fixtureRoot, plan);
		assert.equal(desktopBuildIsCurrent(state, initial, output), false);
		writeDesktopBuildState(state, initial);
		assert.equal(desktopBuildIsCurrent(state, initial, output), false);
		await mkdir(join(directory, "dist"));
		await writeFile(output, "");
		assert.equal(desktopBuildIsCurrent(state, initial, output), true);
		await writeFile(source, "export const changed = true;\n");
		const sourceChanged = desktopBuildFingerprint(fixtureRoot, plan);
		assert.notEqual(sourceChanged, initial);
		assert.equal(desktopBuildIsCurrent(state, sourceChanged, output), false);
		writeDesktopBuildState(state, sourceChanged);
		assert.equal(desktopBuildIsCurrent(state, sourceChanged, output), true);
		await writeFile(installedLock, '{"changed":true}\n');
		assert.equal(desktopBuildIsCurrent(state, desktopBuildFingerprint(fixtureRoot, plan), output), false);
	} finally { await rm(fixtureRoot, { recursive: true, force: true }); }
});

async function runStart(args) {
	const directory = await mkdtemp(join(tmpdir(), "amazme-desktop-start-"));
	try {
		const log = join(directory, "calls.log");
		const bin = join(directory, "bin");
		await mkdir(bin);
		const recorder = `#!/usr/bin/env bash\nprintf '%s|%s|%s\\n' "$(basename "$0")" "$PWD" "$*" >> ${JSON.stringify(log)}\n`;
		for (const name of ["uv", "npm"]) {
			const executable = join(bin, name);
			await writeFile(executable, recorder);
			await chmod(executable, 0o755);
		}
		const result = await new Promise(resolve => execFile(join(root, "start.sh"), args, {
			cwd: directory, timeout: 10000, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, AMAZME_PYTHON_BACKEND: join(bin, "uv") },
		}, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
		assert.equal(result.error, null, result.stderr);
		return (await readFile(log, "utf8")).trim().split("\n");
	} finally { await rm(directory, { recursive: true, force: true }); }
}

test("the root start script prepares dependencies without launching", { skip: process.platform === "win32" }, async () => {
	assert.deepEqual(await runStart(["--prepare"]), [
		`uv|${root}|sync --project backend --frozen`,
		`npm|${root}|install --ignore-scripts`,
	]);
});

test("the root start script launches from any directory without installing", { skip: process.platform === "win32" }, async () => {
	assert.deepEqual(await runStart([]), [`npm|${root}|run dev:desktop`]);
});
