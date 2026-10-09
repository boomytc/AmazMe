#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPackageArtifacts, installPackageArtifacts } from "./package-artifacts.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const { values } = parseArgs({
	options: { out: { type: "string" }, bun: { type: "string", default: "bun" } },
});
const output = resolve(values.out ?? join(packageDir, "binaries", `${process.platform}-${process.arch}`));
const within = (directory, path) => {
	const part = relative(directory, path);
	return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
};
if (within(repoRoot, output) && !within(join(packageDir, "binaries"), output)) {
	throw new Error("Use coding-agent/binaries or a directory outside the repository to avoid packing build candidates");
}
const version = execFileSync(values.bun, ["--version"], { encoding: "utf8" }).trim();
const [major, minor] = version.split(".").map(Number);
if (!(major > 1 || (major === 1 && minor >= 4))) {
	throw new Error(`Bun >= 1.4 is required for node:sqlite; found ${version}`);
}
if (existsSync(output)) throw new Error(`Binary release directory already exists: ${output}`);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this build through npm run build:binary");
execFileSync(process.execPath, [npmCli, "run", "build", "--workspace", "@amazme/coding-agent"], {
	cwd: repoRoot,
	stdio: "inherit",
});

// Keep the same installed modules for the host, plugin APIs and workers. A compiled entry does
// not replace the runtime package tree that source plugins resolve and rebuild against.
mkdirSync(dirname(output), { recursive: true });
const staging = mkdtempSync(join(dirname(output), ".amazme-binary-"));
try {
	const artifacts = createPackageArtifacts({
		repoRoot,
		directory: join(staging, "artifacts"),
		packageNames: ["@amazme/coding-agent"],
	});
	const release = join(staging, "release");
	installPackageArtifacts({
		artifacts,
		directory: release,
		packageNames: ["@amazme/coding-agent"],
		dependencyLock: JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")),
		overrides: JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).overrides,
	});
	const installed = join(release, "node_modules", "@amazme", "coding-agent");
	const binaryName = process.platform === "win32" ? "amazme.exe" : "amazme";
	execFileSync(
		values.bun,
		[
			"build",
			"--compile",
			"--compile-autoload-package-json",
			"--no-compile-autoload-bunfig",
			"--no-compile-autoload-dotenv",
			"./dist/bun/launcher.js",
			"--outfile",
			join(installed, binaryName),
		],
		{ cwd: packageDir, stdio: "inherit" },
	);
	for (const [source, target] of [
		["dist/modes/interactive/theme", "theme"],
		["dist/modes/interactive/assets", "assets"],
		["dist/core/export-html", "export-html"],
	])
		cpSync(join(installed, source), join(installed, target), { recursive: true });
	if (process.platform !== "win32") {
		symlinkSync(join("node_modules", "@amazme", "coding-agent", binaryName), join(release, "amazme"));
	}
	rmSync(join(release, ".npm-cache"), { recursive: true, force: true });
	rmSync(join(release, "package-lock.json"));
	writeFileSync(
		join(release, "package.json"),
		`${JSON.stringify(
			{
				private: true,
				type: "module",
				dependencies: { "@amazme/coding-agent": artifacts.get("@amazme/coding-agent").version },
			},
			null,
			"\t",
		)}\n`,
	);
	const executable = process.platform === "win32" ? join(installed, binaryName) : join(release, "amazme");
	const actual = execFileSync(executable, ["--version"], {
		cwd: staging,
		env: { ...process.env, AMAZME_CODING_AGENT_DIR: join(staging, "profile"), AMAZME_OFFLINE: "1" },
		encoding: "utf8",
	}).trim();
	if (actual !== artifacts.get("@amazme/coding-agent").version) {
		throw new Error(`Compiled binary reported the wrong version: ${actual}`);
	}
	renameSync(release, output);
	console.log(`Built binary release with Bun ${version}: ${output}`);
	console.log("Distribute the complete directory; the installed modules support plugin builds and runtime assets.");
} finally {
	rmSync(staging, { recursive: true, force: true });
}
