import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const icon = join(packageDirectory, "assets", "app-icon.icns");

/** Dock labels use the native bundle identity, not Electron's app.setName(). */
async function macosExecutable(electron: string): Promise<string> {
	const source = dirname(dirname(dirname(electron)));
	const info = join(source, "Contents", "Info.plist");
	const runtime = await stat(electron);
	const manifest = await readFile(join(packageDirectory, "package.json"));
	const digest = createHash("sha256")
		.update(electron)
		.update(process.execPath)
		.update(packageDirectory)
		.update(manifest)
		.update(`${runtime.size}:${runtime.mtimeMs}`)
		.update(await readFile(info))
		.update(await readFile(icon))
		.update(await readFile(fileURLToPath(import.meta.url)))
		.digest("hex").slice(0, 16);
	const cache = join(homedir(), "Library", "Caches", "AmazMe", "desktop");
	const destination = join(cache, digest);
	const executable = join(destination, "AmazMe.app", "Contents", "MacOS", "AmazMe");
	try {
		await access(executable, constants.X_OK);
		return executable;
	} catch (error: unknown) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	await mkdir(cache, { recursive: true });
	const scratch = await mkdtemp(join(cache, ".prepare-"));
	try {
		const bundle = join(scratch, "AmazMe.app");
		await cp(source, bundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
		const contents = join(bundle, "Contents");
		const plist = join(contents, "Info.plist");
		for (const [key, value] of Object.entries({
			CFBundleName: "AmazMe",
			CFBundleDisplayName: "AmazMe",
			CFBundleIdentifier: "com.amazme.desktop",
			CFBundleExecutable: "AmazMe",
			CFBundleIconFile: "app-icon.icns",
		})) {
			await run("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
		}
		await rename(join(contents, "MacOS", basename(electron)), join(contents, "MacOS", "AmazMe"));
		await copyFile(icon, join(contents, "Resources", "app-icon.icns"));
		// Keep the package entry in the bundle so launching its Dock icon after quitting still opens AmazMe.
		const entry = join(contents, "Resources", "app");
		await mkdir(entry);
		const { version } = JSON.parse(manifest.toString("utf8")) as { version: string };
		await writeFile(join(entry, "package.json"), JSON.stringify({ name: "AmazMe", version, type: "module", main: "main.mjs" }));
		await writeFile(join(entry, "main.mjs"), [
			'import { homedir } from "node:os";',
			"process.env.INIT_CWD ??= homedir();",
			`await import(${JSON.stringify(pathToFileURL(join(packageDirectory, "dist", "main.js")).href)});`,
			"",
		].join("\n"));
		await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", bundle]);
		try {
			await rename(scratch, destination);
		} catch (error: unknown) {
			if (!(error instanceof Error) || !("code" in error) || !["EEXIST", "ENOTEMPTY"].includes(String(error.code))) throw error;
			// Another launch finished the same immutable bundle while this one prepared it.
			await access(executable, constants.X_OK);
		}
		return executable;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

async function start(): Promise<void> {
	const electron: unknown = createRequire(import.meta.url)("electron");
	if (typeof electron !== "string" || electron.length === 0) throw new Error("Electron executable is unavailable");
	const executable = process.platform === "darwin" ? await macosExecutable(electron) : electron;
	const args = process.platform === "darwin" ? process.argv.slice(2) : [packageDirectory, ...process.argv.slice(2)];
	const child = spawn(executable, args, {
		stdio: "inherit", windowsHide: false,
		env: { ...process.env, INIT_CWD: process.env.INIT_CWD ?? process.cwd() },
	});
	let closed = false;
	child.once("error", (error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
	child.once("close", (code) => {
		closed = true;
		process.exitCode = code ?? 1;
	});
	for (const signal of ["SIGINT", "SIGTERM", "SIGUSR2"] as const) {
		process.on(signal, () => { if (!closed) child.kill(signal); });
	}
}

// The child process owns the lifetime of this entry; its close handler sets the final exit code.
start().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
