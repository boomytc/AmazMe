#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { workspaceBuildPlan } from "./build-workspace-dependencies.mjs";
import { workspacePackages } from "./package-artifacts.mjs";
import { heldWorkspaceLock, lockStdio, runWithWorkspaceLock } from "./workspace-lock.mjs";

function hashFile(hash, root, path) {
	if (lstatSync(path).isSymbolicLink()) throw new Error(`桌面构建指纹不支持符号链接: ${path}`);
	hash.update(relative(root, path)).update("\0").update(readFileSync(path)).update("\0");
}

function hashDirectory(hash, root, directory) {
	const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`桌面构建指纹不支持符号链接: ${path}`);
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
			if (entry.isSymbolicLink() && (["assets", "src", "package.json", "tsconfig.json", "tsconfig.build.json"].includes(entry.name) || entry.name.endsWith(".mjs"))) throw new Error(`桌面构建指纹不支持符号链接: ${path}`);
			if (entry.isDirectory() && ["assets", "src"].includes(entry.name)) hashDirectory(hash, root, path);
			else if (entry.isFile() && (entry.name === "package.json" || /^tsconfig(?:\.build)?\.json$/.test(entry.name) || entry.name.endsWith(".mjs"))) hashFile(hash, root, path);
		}
	}
	return hash.digest("hex");
}

function desktopOutputFingerprint(output) {
	const hash = createHash("sha256");
	for (const path of Array.isArray(output) ? output : [output]) {
		if (!existsSync(path)) return undefined;
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error(`桌面构建指纹不支持符号链接: ${path}`);
		if (stat.isDirectory()) hashDirectory(hash, path, path);
		else hashFile(hash, dirname(path), path);
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function desktopBuildIsCurrent(state, fingerprint, output) {
	try {
		const saved = JSON.parse(readFileSync(state, "utf8"));
		const currentOutput = desktopOutputFingerprint(output);
		return currentOutput !== undefined && saved.input === fingerprint && saved.output === currentOutput;
	}
	catch { return false; }
}

export function writeDesktopBuildState(state, fingerprint, output) {
	const outputFingerprint = desktopOutputFingerprint(output);
	if (outputFingerprint === undefined) throw new Error("桌面构建缺少必要产物");
	mkdirSync(dirname(state), { recursive: true });
	writeFileSync(state, `${JSON.stringify({ input: fingerprint, output: outputFingerprint })}\n`);
}

async function checkOrBuild(root, lock) {
	const plan = await workspaceBuildPlan(root, ["@amazme/gui"]);
	const fingerprint = desktopBuildFingerprint(root, plan);
	const state = resolve(root, process.env.AMAZME_DEV_DESKTOP_BUILD_STATE || join(".artifacts", "dev-desktop-build.sha256"));
	const outputs = ["main.js", "start.js", "preload.cjs", "updates/update-preload.cjs", "updates/update-window.html", "updates/update-window.js"]
		.map(name => join(root, "packages", "gui", "dist", name));
	outputs.push(...["index.html", "page.js", "page.css"].map(name => join(root, "packages", "web", "dist", "page", name)));
	outputs.push(join(root, "packages", "gui", "dist"), join(root, "packages", "web", "dist", "page"));
	const current = desktopBuildIsCurrent(state, fingerprint, outputs);
	if (process.argv.includes("--check-build")) {
		if (!current) throw new Error("桌面源码构建已过期，请先运行 npm run dev:desktop -- --build-only");
		return;
	}
	if (!current) {
		const result = spawnSync(process.execPath, [fileURLToPath(new URL("./build-workspace-dependencies.mjs", import.meta.url)), "@amazme/gui"], { cwd: root, stdio: lockStdio(lock) });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`桌面依赖构建失败: ${result.status ?? 1}`);
		if (desktopBuildFingerprint(root, plan) !== fingerprint) throw new Error("桌面源码在构建期间发生变化，请重新构建");
		writeDesktopBuildState(state, fingerprint, outputs);
	}
}

async function main() {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const backend = resolve(root, process.env.AMAZME_PYTHON_BACKEND || join("backend", ".venv",
		process.platform === "win32" ? "Scripts" : "bin",
		process.platform === "win32" ? "amazme-backend.exe" : "amazme-backend"));
	const lock = heldWorkspaceLock(root);
	if (lock === undefined) {
		const mode = process.argv.includes("--check-build") ? "--check-build" : "--build-only";
		const status = runWithWorkspaceLock(root, [fileURLToPath(import.meta.url), mode]);
		if (status !== 0) { process.exitCode = status; return; }
	} else {
		await checkOrBuild(root, lock);
	}
	if (process.argv.includes("--build-only") || process.argv.includes("--check-build")) return;

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
