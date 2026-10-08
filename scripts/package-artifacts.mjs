import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

function execNpmSync(args, options) {
	const npmCli = process.env.npm_execpath;
	if (npmCli && existsSync(npmCli)) return execFileSync(process.execPath, [npmCli, ...args], options);
	if (process.platform === "win32")
		throw new Error("Run artifact installation through npm so its CLI can be located on Windows");
	return execFileSync("npm", args, options);
}

/** Top-level product packages; examples and test fixtures are not install artifacts. */
export function workspacePackages(repoRoot) {
	const packages = readdirSync(join(repoRoot, "packages"), {
		withFileTypes: true,
	})
		.filter((entry) => entry.isDirectory() && existsSync(join(repoRoot, "packages", entry.name, "package.json")))
		.map((entry) => {
			const directory = join(repoRoot, "packages", entry.name);
			const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
			return [manifest.name, { directory, manifest }];
		});
	const names = new Set();
	for (const [name] of packages) {
		if (typeof name !== "string" || names.has(name))
			throw new Error(`Invalid or duplicate workspace package: ${String(name)}`);
		names.add(name);
	}
	return new Map(packages);
}

/** Dependency order for the selected runtime, rejecting undeclared local packages and cycles. */
export function runtimePackages(packages, names) {
	const visiting = new Set();
	const visited = new Set();
	const ordered = [];
	const visit = (name) => {
		if (visiting.has(name)) throw new Error(`Workspace dependency cycle at ${name}`);
		if (visited.has(name)) return;
		const pkg = packages.get(name);
		if (!pkg) throw new Error(`Unknown workspace package: ${name}`);
		visiting.add(name);
		for (const dependency of Object.keys({
			...pkg.manifest.dependencies,
			...pkg.manifest.optionalDependencies,
		})) {
			if (dependency.startsWith("@amazme/")) visit(dependency);
		}
		visiting.delete(name);
		visited.add(name);
		ordered.push(pkg);
	};
	for (const name of names) visit(name);
	return ordered;
}

function inside(path, directory) {
	const part = relative(directory, path);
	return (
		part === "" ||
		(!isAbsolute(part) && part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
	);
}

function packageTargets(value, targets = []) {
	if (typeof value === "string") targets.push(value);
	else if (Array.isArray(value)) value.forEach((entry) => packageTargets(entry, targets));
	else if (value && typeof value === "object") {
		for (const [condition, entry] of Object.entries(value)) {
			if (condition !== "source") packageTargets(entry, targets);
		}
	}
	return targets;
}

/** Validate actual npm pack contents, not just files in the source checkout. */
export function verifyPackedFiles(manifest, files) {
	const included = new Set(files.map((file) => file.path));
	const targets = [
		manifest.main,
		manifest.types,
		...Object.values(typeof manifest.bin === "string" ? { bin: manifest.bin } : (manifest.bin ?? {})),
		...packageTargets(manifest.exports),
	].filter(Boolean);
	for (const target of targets) {
		const path = target.replace(/^\.\//, "");
		if (path.includes("*")) {
			const pattern = new RegExp(
				`^${path
					.split("*")
					.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
					.join(".+")}$`,
			);
			if (![...included].some((file) => pattern.test(file)))
				throw new Error(`${manifest.name} has no packed files for ${target}`);
		} else if (!included.has(path)) throw new Error(`${manifest.name} is missing packed entry ${target}`);
	}
}

/** Pack a coherent dependency closure from already built packages, without lifecycle scripts. */
export function createPackageArtifacts({ repoRoot, directory, packageNames }) {
	if (packageNames.length === 0) throw new Error("Select at least one package to pack");
	const root = resolve(repoRoot);
	const output = resolve(directory);
	if (inside(root, output)) throw new Error("Artifact directory must not contain the repository");
	if (existsSync(output) && readdirSync(output).length > 0)
		throw new Error(`Artifact directory is not empty: ${output}`);
	const packages = runtimePackages(workspacePackages(root), packageNames);
	mkdirSync(output, { recursive: true });
	const artifacts = packages.map(({ directory: cwd, manifest }) => {
		const packed = JSON.parse(
			execNpmSync(
				["pack", "--ignore-scripts", "--json", "--cache", join(output, ".npm-cache"), "--pack-destination", output],
				{
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "inherit"],
					timeout: 60_000,
				},
			),
		);
		if (packed.length !== 1 || !packed[0].filename) throw new Error(`Unexpected npm pack result for ${manifest.name}`);
		verifyPackedFiles(manifest, packed[0].files);
		const tarball = join(output, packed[0].filename);
		return {
			name: manifest.name,
			version: manifest.version,
			tarball: packed[0].filename,
			integrity: `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
		};
	});
	const manifestPath = join(output, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify({ version: 1, packages: artifacts }, null, "\t")}\n`);
	return readPackageArtifacts(manifestPath);
}

/** Read and verify every artifact before an installer can use it. */
export function readPackageArtifacts(manifestPath) {
	const directory = resolve(manifestPath, "..");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.version !== 1 || !Array.isArray(manifest.packages) || manifest.packages.length === 0)
		throw new Error("Invalid package artifact manifest");
	const packages = new Map();
	for (const pkg of manifest.packages) {
		if (
			typeof pkg.name !== "string" ||
			typeof pkg.version !== "string" ||
			typeof pkg.tarball !== "string" ||
			typeof pkg.integrity !== "string" ||
			packages.has(pkg.name)
		)
			throw new Error("Invalid or duplicate package artifact");
		const tarball = resolve(directory, pkg.tarball);
		if (!inside(tarball, directory)) throw new Error(`Artifact path leaves its directory: ${pkg.tarball}`);
		const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
		if (integrity !== pkg.integrity) throw new Error(`Artifact integrity mismatch: ${pkg.name}`);
		packages.set(pkg.name, { ...pkg, tarball });
	}
	return packages;
}

/** Install into an empty consumer, forcing all internal dependencies to these exact tarballs. */
export function installPackageArtifacts({
	artifacts,
	directory,
	packageNames,
	dependencies = {},
	overrides = {},
	dependencyLock,
	offline = false,
}) {
	const consumer = resolve(directory);
	if (existsSync(consumer) && readdirSync(consumer).length > 0)
		throw new Error(`Consumer directory is not empty: ${consumer}`);
	if (packageNames.length === 0) throw new Error("Select at least one package to install");
	const specifiers = Object.fromEntries(
		[...artifacts].map(([name, pkg]) => [name, `file:./${relative(consumer, pkg.tarball).replaceAll("\\", "/")}`]),
	);
	for (const name of packageNames) if (!artifacts.has(name)) throw new Error(`No artifact for ${name}`);
	for (const name of Object.keys(dependencies))
		if (name.startsWith("@amazme/")) throw new Error(`Internal dependency must use an artifact: ${name}`);
	mkdirSync(consumer, { recursive: true });
	const manifest = {
		private: true,
		type: "module",
		dependencies: {
			...dependencies,
			...Object.fromEntries(packageNames.map((name) => [name, specifiers[name]])),
		},
		overrides: { ...overrides, ...specifiers },
	};
	writeFileSync(join(consumer, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	if (dependencyLock)
		writeFileSync(
			join(consumer, "package-lock.json"),
			`${JSON.stringify(consumerLock(dependencyLock, artifacts, manifest), null, "\t")}\n`,
		);
	execNpmSync(
		[
			dependencyLock ? "ci" : "install",
			"--ignore-scripts",
			"--omit=dev",
			"--no-audit",
			"--no-fund",
			"--cache",
			join(consumer, ".npm-cache"),
			...(offline ? ["--offline"] : []),
		],
		{ cwd: consumer, stdio: "inherit", timeout: 300_000 },
	);
	verifyInstalledArtifacts({ artifacts, directory: consumer, packageNames });
}

/** Keep the source lock's tested dependency graph, pruned to this consumer's runtime closure. */
export function consumerLock(source, artifacts, manifest) {
	if (source.lockfileVersion !== 3 || !source.packages)
		throw new Error("A version 3 source dependency lock is required");
	const available = new Map(
		Object.entries(source.packages).filter(([path, pkg]) => path.startsWith("node_modules/") && !pkg.link),
	);
	for (const [name, artifact] of artifacts) {
		const path = `node_modules/${name}`;
		const original = source.packages[path];
		const pkg = original?.link ? source.packages[original.resolved] : original;
		if (!pkg || pkg.version !== artifact.version) throw new Error(`Source lock does not match artifact: ${name}`);
		available.set(path, {
			...pkg,
			name,
			resolved: manifest.overrides[name],
			integrity: artifact.integrity,
		});
		if (original?.link) {
			const prefix = `${original.resolved}/node_modules/`;
			for (const [nestedPath, nested] of Object.entries(source.packages)) {
				if (nestedPath.startsWith(prefix) && !nested.link)
					available.set(`${path}/node_modules/${nestedPath.slice(prefix.length)}`, nested);
			}
		}
	}
	const selected = new Map();
	const resolveDependency = (parent, name) => {
		let scope = parent;
		while (true) {
			const candidate = `${scope ? `${scope}/` : ""}node_modules/${name}`;
			if (available.has(candidate)) return candidate;
			if (scope === "") return undefined;
			const index = scope.lastIndexOf("/node_modules/");
			scope = index < 0 ? "" : scope.slice(0, index);
		}
	};
	const visit = (parent, name, optional = false) => {
		const path = resolveDependency(parent, name);
		if (path === undefined) {
			if (optional) return;
			throw new Error(`Source lock is missing dependency ${name} of ${parent || "consumer"}`);
		}
		if (selected.has(path)) return;
		const { dev: _dev, devOptional: _devOptional, link: _link, ...pkg } = available.get(path);
		const supports = (values, current) =>
			values === undefined ||
			(!values.includes(`!${current}`) &&
				(!values.some((value) => !value.startsWith("!")) || values.includes(current) || values.includes("any")));
		if (optional && (!supports(pkg.os, process.platform) || !supports(pkg.cpu, process.arch))) return;
		selected.set(path, pkg);
		for (const dependency of Object.keys(pkg.dependencies ?? {}))
			visit(path, dependency, Object.hasOwn(pkg.optionalDependencies ?? {}, dependency));
		for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) visit(path, dependency, true);
		for (const dependency of Object.keys(pkg.peerDependencies ?? {})) {
			if (pkg.peerDependenciesMeta?.[dependency]?.optional !== true) visit(path, dependency);
		}
	};
	for (const name of Object.keys(manifest.dependencies)) visit("", name);
	return {
		lockfileVersion: 3,
		requires: true,
		packages: {
			"": { dependencies: manifest.dependencies },
			...Object.fromEntries(selected),
		},
	};
}

/** Installed workspace packages must resolve from the selected artifact, never from a registry or source link. */
export function verifyInstalledArtifacts({ artifacts, directory, packageNames }) {
	const lock = JSON.parse(readFileSync(join(directory, "package-lock.json"), "utf8"));
	const found = new Set();
	for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
		const marker = path.lastIndexOf("node_modules/");
		const name = marker < 0 ? undefined : path.slice(marker + "node_modules/".length);
		const expected = artifacts.get(name);
		if (!expected) continue;
		if (
			typeof pkg.resolved !== "string" ||
			!pkg.resolved.startsWith("file:") ||
			resolve(directory, pkg.resolved.slice("file:".length)) !== expected.tarball ||
			pkg.version !== expected.version ||
			pkg.integrity !== expected.integrity ||
			pkg.link
		)
			throw new Error(`Installed package does not match its artifact: ${name}`);
		const manifest = JSON.parse(readFileSync(join(directory, path, "package.json"), "utf8"));
		if (manifest.name !== name || manifest.version !== expected.version)
			throw new Error(`Installed package identity mismatch: ${name}`);
		found.add(name);
	}
	for (const name of packageNames) if (!found.has(name)) throw new Error(`Installed package is missing: ${name}`);
}
