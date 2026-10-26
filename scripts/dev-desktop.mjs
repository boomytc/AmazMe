#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { workspaceBuildPlan } from "./build-workspace-dependencies.mjs";
import { workspacePackages } from "./package-artifacts.mjs";

function hashFile(hash, root, path) {
	hash.update(relative(root, path)).update("\0").update(readFileSync(path)).update("\0");
}

function hashDirectory(hash, root, directory) {
	const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) hashDirectory(hash, root, path);
		else if (entry.isFile()) hashFile(hash, root, path);
	}
}

export function desktopBuildFingerprint(root, plan) {
	const hash = createHash("sha256");
	for (const name of ["node_modules/.package-lock.json", "tsconfig.base.json", "tsconfig.browser.json", "tsconfig.node.json", "scripts/build-update-helper.mjs", "scripts/build-workspace-dependencies.mjs", "scripts/package-artifacts.mjs"]) {
		const path = join(root, name);
		if (existsSync(path)) hashFile(hash, root, path);
	}
	const packages = workspacePackages(root);
	for (const { name } of plan) {
		const pkg = packages.get(name);
		if (pkg === undefined) throw new Error(`Unknown workspace package: ${name}`);
		const entries = readdirSync(pkg.directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const path = join(pkg.directory, entry.name);
			if (entry.isDirectory() && ["assets", "src"].includes(entry.name)) hashDirectory(hash, root, path);
			else if (entry.isFile() && (entry.name === "package.json" || /^tsconfig(?:\.build)?\.json$/.test(entry.name) || entry.name.endsWith(".mjs"))) hashFile(hash, root, path);
		}
	}
	return hash.digest("hex");
}

export function desktopBuildIsCurrent(state, fingerprint, output) {
	if (!existsSync(output)) return false;
	try { return readFileSync(state, "utf8").trim() === fingerprint; }
	catch { return false; }
}

export function writeDesktopBuildState(state, fingerprint) {
	mkdirSync(dirname(state), { recursive: true });
	writeFileSync(state, `${fingerprint}\n`);
}

async function main() {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const backend = resolve(root, process.env.AMAZME_PYTHON_BACKEND || join("backend", ".venv",
		process.platform === "win32" ? "Scripts" : "bin",
		process.platform === "win32" ? "amazme-backend.exe" : "amazme-backend"));
	const plan = await workspaceBuildPlan(root, ["@amazme/gui"]);
	const fingerprint = desktopBuildFingerprint(root, plan);
	const state = resolve(root, process.env.AMAZME_DEV_DESKTOP_BUILD_STATE || join(".artifacts", "dev-desktop-build.sha256"));
	if (!desktopBuildIsCurrent(state, fingerprint, join(root, "packages", "gui", "dist", "main.js"))) {
		const result = spawnSync(process.execPath, [fileURLToPath(new URL("./build-workspace-dependencies.mjs", import.meta.url)), "@amazme/gui"], { cwd: root, stdio: "inherit" });
		if (result.error) throw result.error;
		if (result.status !== 0) { process.exitCode = result.status ?? 1; return; }
		writeDesktopBuildState(state, fingerprint);
	}

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
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
