import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How the shell finds and starts the web host.
 *
 * The durable page lives on the experimental `web` command (`scripts/dev-web.mjs` runs the same
 * two files). The bundled CLI does not serve it. The command is started with system Node: its
 * session workers spawn `process.execPath`, and that executable has to be Node because the host
 * uses `node:sqlite`. Electron's utility process is a different runtime, so it is not the parent.
 */

const SOURCE_RESOLVER = "packages/coding-agent/src/experimental/source-resolver.ts";
const CLI_ENTRY = "packages/coding-agent/src/experimental/cli.ts";

/** Repo root from a compiled or source module at `packages/gui/{src,dist}/`. */
export function repositoryRootFromModule(moduleUrl: string | URL): string {
	const root = fileURLToPath(new URL("../../..", moduleUrl));
	return root.length > sep.length && root.endsWith(sep) ? root.slice(0, -1) : root;
}

/**
 * Node that will run the host. `AMAZME_GUI_NODE` wins; otherwise the Node that npm used to start
 * Electron. `process.execPath` inside Electron is Electron itself, so it is not a candidate.
 */
export function resolveNodeExecutable(env: NodeJS.ProcessEnv): string {
	const override = env.AMAZME_GUI_NODE;
	if (override !== undefined && override.length > 0) return override;
	const fromNpm = env.npm_node_execpath;
	if (fromNpm !== undefined && fromNpm.length > 0 && existsSync(fromNpm)) return fromNpm;
	return "node";
}

/** Argv and environment of one `web` host process. */
export interface WebHostLaunch {
	readonly nodeExecutable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	/** Source files the child loads. Missing means the checkout cannot serve the page. */
	readonly entries: readonly string[];
}

export function webHostLaunch(input: {
	readonly nodeExecutable: string;
	readonly repositoryRoot: string;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}): WebHostLaunch {
	const resolver = join(input.repositoryRoot, SOURCE_RESOLVER);
	const cli = join(input.repositoryRoot, CLI_ENTRY);
	// Drop Electron's environment. The child is a normal Node process running the existing host.
	const env: NodeJS.ProcessEnv = { AMAZME_EXPERIMENTAL: "1" };
	for (const [key, value] of Object.entries(input.env)) {
		if (value === undefined || key.startsWith("ELECTRON_")) continue;
		env[key] = value;
	}
	env.AMAZME_EXPERIMENTAL = "1";
	return {
		nodeExecutable: input.nodeExecutable,
		args: ["--import", resolver, cli, "web", "--port", "0"],
		cwd: input.cwd,
		env,
		entries: [resolver, cli],
	};
}

/** Working directory for the host: an explicit project, otherwise the checkout (same as dev:web). */
export function hostWorkingDirectory(env: NodeJS.ProcessEnv, repositoryRoot: string): string {
	const override = env.AMAZME_GUI_CWD;
	if (override !== undefined && override.length > 0) return override;
	return repositoryRoot;
}

export function missingHostEntry(launch: WebHostLaunch): string | undefined {
	return launch.entries.find((entry) => !existsSync(entry));
}
