import { resolve } from "node:path";
import { workspaceDependencyPackages, workspacePackages } from "./package-artifacts.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Build only the target's workspace closure, including workspace-only build-time dependencies. */
export async function workspaceBuildPlan(root, targets) {
	const packages = workspaceDependencyPackages(workspacePackages(root), targets, ["dependencies", "devDependencies", "optionalDependencies"]);
	return packages.filter(({manifest}) => typeof manifest.scripts?.build === "string")
		.map(({manifest}) => ({name:manifest.name, script:"build"}));
}

export async function buildWorkspaceDependencies(root, targets, run) {
	const plan = await workspaceBuildPlan(root, targets);
	for (const { name, script } of plan) {
		console.log(`desktop dependency: ${name} (${script})`);
		if (await run(name, script) !== 0) throw new Error(`Workspace build failed: ${name}`);
	}
	return plan;
}

async function main() {
	const args = process.argv.slice(2);
	if (args.some((arg) => arg.startsWith("--") && !["--plan"].includes(arg))) throw new Error("Unknown option");
	const targets = args.filter((arg) => !arg.startsWith("--"));
	if (targets.length === 0) throw new Error("Specify a target workspace");
	const root = fileURLToPath(new URL("..", import.meta.url));
	if (args.includes("--plan")) { console.log(JSON.stringify(await workspaceBuildPlan(root, targets), null, 2)); return; }
	const run = (name, script) => {
		const cli = process.env.npm_execpath;
		const executable = cli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
		const result = spawnSync(executable, [...(cli ? [cli] : []), "run", script, "--workspace", name], {
			cwd: root, stdio: "inherit", shell: !cli && process.platform === "win32",
		});
		if (result.error) throw result.error;
		return result.status ?? 1;
	};
	await buildWorkspaceDependencies(root, targets, run);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
