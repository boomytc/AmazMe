import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { desktopBuildFingerprint, desktopBuildIsCurrent, writeDesktopBuildState } from "./dev-desktop.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryBackend = join(root, "backend", ".venv",
	process.platform === "win32" ? "Scripts" : "bin",
	process.platform === "win32" ? "amazme-backend.exe" : "amazme-backend");

async function launch(backend, failBuild = false, args = [], modifySource = false) {
	const directory = await mkdtemp(join(tmpdir(), "amazme-dev-desktop-"));
	try {
		const project = join(await realpath(directory), "project");
		await mkdir(join(project, "scripts"), { recursive: true });
		for (const name of ["dev-desktop.mjs", "build-workspace-dependencies.mjs", "package-artifacts.mjs", "workspace-lock.mjs"]) {
			await copyFile(join(root, "scripts", name), join(project, "scripts", name));
		}
		await mkdir(join(project, "backend", "tools"), { recursive: true });
		await copyFile(join(root, "backend", "tools", "workspace_lock.py"), join(project, "backend", "tools", "workspace_lock.py"));
		for (const name of ["web", "gui"]) await mkdir(join(project, "packages", name), { recursive: true });
		await writeFile(join(project, "packages", "web", "package.json"), JSON.stringify({ name: "@amazme/web", scripts: { build: "build" } }));
		await writeFile(join(project, "packages", "gui", "package.json"), JSON.stringify({ name: "@amazme/gui", scripts: { build: "build" }, dependencies: { "@amazme/web": "workspace:*" } }));
		const log = join(directory, "calls.jsonl");
		const cli = join(directory, "npm.mjs");
		const state = join(directory, "build-state");
		await writeFile(cli, `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";\nimport { dirname, join } from "node:path";\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), backend: process.env.AMAZME_PYTHON_BACKEND }) + "\\n");\n${failBuild ? "if (process.argv.slice(2).includes(\"build\")) process.exit(2);" : ""}\nif (process.argv.slice(2).includes("build")) {\nfor (const name of ["packages/gui/dist/main.js", "packages/gui/dist/start.js", "packages/gui/dist/preload.cjs", "packages/gui/dist/updates/update-preload.cjs", "packages/gui/dist/updates/update-window.html", "packages/gui/dist/updates/update-window.js", "packages/web/dist/page/index.html", "packages/web/dist/page/page.js", "packages/web/dist/page/page.css"]) { const output = join(process.cwd(), name); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, "fixture"); }\n${modifySource ? 'const source = join(process.cwd(), "packages/web/src/index.ts"); mkdirSync(dirname(source), { recursive: true }); writeFileSync(source, "changed during build");' : ""}\n}`);
		const result = await new Promise(resolve => execFile(process.execPath, [join(project, "scripts", "dev-desktop.mjs"), ...args], {
			cwd: project, timeout: 10000, env: { ...process.env, npm_execpath: cli, AMAZME_PYTHON_BACKEND: backend, AMAZME_DEV_DESKTOP_BUILD_STATE: state },
		}, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
		if (!failBuild && !modifySource && !args.includes("--check-build")) assert.equal(result.error, null, result.stderr);
		const calls = existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)) : [];
		return { result, calls, state, project };
	} finally { await rm(directory, { recursive: true, force: true }); }
}

test("the desktop launcher uses the repository backend and preserves the build and start sequence", async () => {
	const { calls, project } = await launch("");
	assert.deepEqual(calls.map(call => call.args), [
		["run", "build", "--workspace", "@amazme/web"],
		["run", "build", "--workspace", "@amazme/gui"],
		["start", "--workspace", "@amazme/gui"],
	]);
	assert.equal(calls.at(-1).backend, join(project, "backend", ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "amazme-backend.exe" : "amazme-backend"));
});

test("the desktop launcher preserves an absolute backend and resolves a relative override from the repository", async () => {
	assert.equal((await launch("/custom/amazme-backend")).calls.at(-1).backend, "/custom/amazme-backend");
	const relative = await launch("custom/amazme-backend");
	assert.equal(relative.calls.at(-1).backend, resolve(relative.project, "custom/amazme-backend"));
});

test("a failed dependency build does not start the desktop or write a valid cache", async () => {
	const { result, calls, state } = await launch("", true);
	assert.equal(result.error.code, 1);
	assert.deepEqual(calls.map(call => call.args), [["run", "build", "--workspace", "@amazme/web"]]);
	assert.equal(existsSync(state), false);
});

test("verification can check the build and rebuild without starting the desktop", async () => {
	const stale = await launch("", false, ["--check-build"]);
	assert.equal(stale.result.error.code, 1);
	assert.match(stale.result.stderr, /--build-only/);
	assert.deepEqual(stale.calls, []);
	const built = await launch("", false, ["--build-only"]);
	assert.deepEqual(built.calls.map(call => call.args), [
		["run", "build", "--workspace", "@amazme/web"],
		["run", "build", "--workspace", "@amazme/gui"],
	]);
});

test("a source change during the build cannot be recorded or launched", async () => {
	const { result, calls, state } = await launch("", false, [], true);
	assert.equal(result.error.code, 1);
	assert.match(result.stderr, /源码在构建期间发生变化/);
	assert.equal(calls.some(call => call.args[0] === "start"), false);
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
		await mkdir(join(directory, "dist"));
		await writeFile(output, "");
		await mkdir(dirname(state), { recursive: true });
		await writeFile(state, initial);
		assert.equal(desktopBuildIsCurrent(state, initial, output), false);
		writeDesktopBuildState(state, initial, output);
		assert.equal(desktopBuildIsCurrent(state, initial, output), true);
		await writeFile(output, "other build");
		assert.equal(desktopBuildIsCurrent(state, initial, output), false);
		await writeFile(output, "");
		assert.equal(desktopBuildIsCurrent(state, initial, [output, join(directory, "dist", "missing.js")]), false);
		await writeFile(source, "export const changed = true;\n");
		const sourceChanged = desktopBuildFingerprint(fixtureRoot, plan);
		assert.notEqual(sourceChanged, initial);
		assert.equal(desktopBuildIsCurrent(state, sourceChanged, output), false);
		writeDesktopBuildState(state, sourceChanged, output);
		assert.equal(desktopBuildIsCurrent(state, sourceChanged, output), true);
		const outputDirectory = join(directory, "dist");
		writeDesktopBuildState(state, sourceChanged, outputDirectory);
		await writeFile(join(outputDirectory, "other.js"), "changed asset");
		assert.equal(desktopBuildIsCurrent(state, sourceChanged, outputDirectory), false);
		await writeFile(installedLock, '{"changed":true}\n');
		assert.equal(desktopBuildIsCurrent(state, desktopBuildFingerprint(fixtureRoot, plan), output), false);
	} finally { await rm(fixtureRoot, { recursive: true, force: true }); }
});

test("the build cache rejects symlinks in sources and outputs", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "amazme-dev-symlink-"));
	try {
		const pkg = join(fixture, "packages/gui");
		await mkdir(join(pkg, "src"), { recursive: true });
		await mkdir(join(pkg, "dist"));
		await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@amazme/gui" }));
		await writeFile(join(fixture, "target"), "first");
		const plan = [{ name: "@amazme/gui", script: "build" }];
		const state = join(fixture, "state");
		const output = join(pkg, "dist");
		await symlink(join(fixture, "target"), join(pkg, "src", "linked.ts"));
		assert.throws(() => desktopBuildFingerprint(fixture, plan), /符号链接/);
		await rm(join(pkg, "src", "linked.ts"));
		const fingerprint = desktopBuildFingerprint(fixture, plan);
		await symlink(join(fixture, "target"), join(output, "linked.js"));
		assert.throws(() => writeDesktopBuildState(state, fingerprint, output), /符号链接/);
		assert.equal(desktopBuildIsCurrent(state, fingerprint, output), false);
	} finally { await rm(fixture, { recursive: true, force: true }); }
});

async function runStart(args, { backend: override, expectFailure = false } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "amazme-desktop-start-"));
	try {
		const log = join(directory, "calls.log");
		const bin = join(directory, "bin");
		await mkdir(bin);
		const backend = override ?? join(bin, "uv");
		const recorder = `#!/usr/bin/env bash\nprintf '%s|%s|%s|%s\\n' "$(basename "$0")" "$PWD" "$*" "\${AMAZME_PYTHON_BACKEND:-}" >> ${JSON.stringify(log)}\n`;
		for (const name of ["uv", "npm"]) {
			const executable = join(bin, name);
			await writeFile(executable, recorder);
			await chmod(executable, 0o755);
		}
		const result = await new Promise(resolve => execFile(join(root, "start.sh"), args, {
			cwd: directory, timeout: 10000, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, AMAZME_PYTHON_BACKEND: backend },
		}, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
		if (!expectFailure) assert.equal(result.error, null, result.stderr);
		return { result, calls: existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n") : [], backend: backend.startsWith("/") ? backend : resolve(root, backend) };
	} finally { await rm(directory, { recursive: true, force: true }); }
}

test("the root start script prepares dependencies without launching", { skip: process.platform === "win32" }, async () => {
	const { calls, backend } = await runStart(["--prepare"]);
	assert.deepEqual(calls, [
		`uv|${root}|sync --project backend --frozen|${backend}`,
		`npm|${root}|install --ignore-scripts|${backend}`,
	]);
});

test("the root start script launches the desktop from any directory without installing", { skip: process.platform === "win32" }, async () => {
	const { calls, backend } = await runStart([]);
	assert.deepEqual(calls, [`npm|${root}|run dev:desktop|${backend}`]);
});

test("the root start script launches web and cli with an absolute repository backend", { skip: process.platform === "win32" }, async () => {
	const web = await runStart(["web"]);
	assert.deepEqual(web.calls, [`npm|${root}|run dev:web|${web.backend}`]);

	const cli = await runStart(["cli", "--print", "hi there"]);
	assert.deepEqual(cli.calls, [`npm|${root}|run dev:tui -- --print hi there|${cli.backend}`]);

	const relative = await runStart(["cli"], { backend: "backend/.venv/bin/amazme-backend" });
	assert.equal(relative.backend, repositoryBackend);
	assert.deepEqual(relative.calls, [`npm|${root}|run dev:tui|${repositoryBackend}`]);
});

test("the root start script rejects an unknown mode or desktop arguments", { skip: process.platform === "win32" }, async () => {
	for (const args of [["mobile"], ["desktop", "--print", "hi"]]) {
		const { result, calls } = await runStart(args, { expectFailure: true });
		assert.equal(result.error.code, 2);
		assert.match(result.stderr, /用法：\.\/start\.sh \[desktop\|web\|cli\]/);
		assert.deepEqual(calls, []);
	}
});
