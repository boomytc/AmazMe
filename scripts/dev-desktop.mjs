#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const backend = resolve(root, process.env.AMAZME_PYTHON_BACKEND || join("backend", ".venv",
	process.platform === "win32" ? "Scripts" : "bin",
	process.platform === "win32" ? "amazme-backend.exe" : "amazme-backend"));
const result = spawnSync(process.execPath, [fileURLToPath(new URL("./build-workspace-dependencies.mjs", import.meta.url)), "@amazme/gui"], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const cli = process.env.npm_execpath;
const executable = cli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(executable, [...(cli ? [cli] : []), "start", "--workspace", "@amazme/gui"], {
	cwd: root, stdio: "inherit", shell: !cli && process.platform === "win32",
	env: { ...process.env, AMAZME_PYTHON_BACKEND: backend },
});
const interrupt = () => child.kill("SIGINT");
const terminate = () => child.kill("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => {
	process.off("SIGINT", interrupt);
	process.off("SIGTERM", terminate);
	process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});
