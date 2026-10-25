import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const launcher = fileURLToPath(new URL("./dev-desktop.mjs", import.meta.url));
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryBackend = join(root, "backend", ".venv",
	process.platform === "win32" ? "Scripts" : "bin",
	process.platform === "win32" ? "amazme-backend.exe" : "amazme-backend");

async function launch(backend) {
	const directory = await mkdtemp(join(tmpdir(), "amazme-dev-desktop-"));
	try {
		const log = join(directory, "calls.jsonl");
		const cli = join(directory, "npm.mjs");
		await writeFile(cli, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), backend: process.env.AMAZME_PYTHON_BACKEND }) + "\\n");\n`);
		const result = await new Promise(resolve => execFile(process.execPath, [launcher], {
			cwd: root, timeout: 10000, env: { ...process.env, npm_execpath: cli, AMAZME_PYTHON_BACKEND: backend },
		}, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
		assert.equal(result.error, null, result.stderr);
		return (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
	} finally { await rm(directory, { recursive: true, force: true }); }
}

test("the desktop launcher uses the repository backend and preserves the build and start sequence", async () => {
	const calls = await launch("");
	assert.deepEqual(calls.map(call => call.args), [
		["run", "build", "--workspace", "@amazme/web"],
		["run", "build", "--workspace", "@amazme/gui"],
		["start", "--workspace", "@amazme/gui"],
	]);
	assert.equal(calls.at(-1).backend, repositoryBackend);
});

test("the desktop launcher preserves an absolute backend and resolves a relative override from the repository", async () => {
	assert.equal((await launch("/custom/amazme-backend")).at(-1).backend, "/custom/amazme-backend");
	assert.equal((await launch("custom/amazme-backend")).at(-1).backend, resolve(root, "custom/amazme-backend"));
});

test("the root start script prepares and launches the desktop from any directory", { skip: process.platform === "win32" }, async () => {
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
		const result = await new Promise(resolve => execFile(join(root, "start.sh"), [], {
			cwd: directory, timeout: 10000, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
		}, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
		assert.equal(result.error, null, result.stderr);
		assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
			`uv|${root}|sync --project backend --frozen`,
			`npm|${root}|install --ignore-scripts`,
			`npm|${root}|run dev:desktop`,
		]);
	} finally { await rm(directory, { recursive: true, force: true }); }
});
