import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Top-level product workspaces. */
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

/** Workspace dependency traversal shared by compilation and dependency checks. */
export function workspaceDependencyPackages(packages, names, fields) {
	const visiting = new Set();
	const visited = new Set();
	const ordered = [];
	const visit = (name) => {
		if (visiting.has(name)) throw new Error(`Workspace dependency cycle at ${name}`);
		if (visited.has(name)) return;
		const pkg = packages.get(name);
		if (!pkg) throw new Error(`Unknown workspace package: ${name}`);
		visiting.add(name);
		const dependencies = Object.assign({}, ...fields.map((field) => pkg.manifest[field]));
		for (const dependency of Object.keys(dependencies)) {
			if (packages.has(dependency) || dependency.startsWith("@amazme/")) visit(dependency);
		}
		visiting.delete(name);
		visited.add(name);
		ordered.push(pkg);
	};
	for (const name of names) visit(name);
	return ordered;
}

/** Runtime dependencies omit development dependencies. */
export function runtimePackages(packages, names) {
	return workspaceDependencyPackages(packages, names, ["dependencies", "optionalDependencies"]);
}
