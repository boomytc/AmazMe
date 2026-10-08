import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageArtifacts, installPackageArtifacts } from "../../../scripts/package-artifacts.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const outputDirectory = process.argv[2];
if (!outputDirectory || process.argv.length !== 3) {
	throw new Error("Usage: node packages/evals/docker/install-runtime.mjs <output-directory>");
}

const evalPackage = JSON.parse(readFileSync(join(repositoryRoot, "packages/evals/package.json"), "utf8"));
const packageNames = ["@amazme/coding-agent"];
const artifacts = createPackageArtifacts({
	repoRoot: repositoryRoot,
	directory: join(outputDirectory, "tarballs"),
	packageNames,
});
const evaluatorDependencies = Object.fromEntries(
	Object.entries(evalPackage.devDependencies).filter(([name]) => !artifacts.has(name)),
);
const installDirectory = join(outputDirectory, "install");
installPackageArtifacts({
	artifacts,
	directory: installDirectory,
	packageNames,
	dependencies: evaluatorDependencies,
	overrides: JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).overrides,
	dependencyLock: JSON.parse(readFileSync(join(repositoryRoot, "package-lock.json"), "utf8")),
});

for (const packageName of artifacts.keys()) {
	if (packageName === "@amazme/coding-agent") continue;
	const packageDirectory = join(installDirectory, "node_modules", ...packageName.split("/"));
	if (!existsSync(packageDirectory)) continue;
	for (const entry of readdirSync(packageDirectory, { withFileTypes: true })) {
		if (
			(entry.isDirectory() && ["docs", "examples", "src", "test", "tests"].includes(entry.name)) ||
			(entry.isFile() && /^(?:readme|changelog)(?:\..+)?$/i.test(entry.name))
		) {
			rmSync(join(packageDirectory, entry.name), { force: true, recursive: true });
		}
	}
}

const runtimeRoot = join(outputDirectory, "root");
const runtimeEvalRoot = join(runtimeRoot, "packages/evals");
mkdirSync(join(runtimeEvalRoot, "docker"), { recursive: true });
for (const file of ["package.json", "vitest.base.ts"]) {
	cpSync(join(repositoryRoot, file), join(runtimeRoot, file));
}
for (const file of ["package.json", "vitest.evals.config.ts"]) {
	cpSync(join(repositoryRoot, "packages/evals", file), join(runtimeEvalRoot, file));
}
for (const directory of ["src", "evals"]) {
	cpSync(join(repositoryRoot, "packages/evals", directory), join(runtimeEvalRoot, directory), { recursive: true });
}
cpSync(
	join(repositoryRoot, "packages/evals/docker/entrypoint.ts"),
	join(runtimeEvalRoot, "docker/entrypoint.ts"),
);
