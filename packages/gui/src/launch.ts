import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolve the installed coding-agent distribution through this application's dependency. */
export function resolveHostCli(): string {
	return fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@amazme/coding-agent")));
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
	/** Installed entry the child loads. Missing means the runtime is incomplete. */
	readonly entries: readonly string[];
}

export function webHostLaunch(input: {
	readonly nodeExecutable: string;
	readonly cliEntry: string;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}): WebHostLaunch {
	const cli = input.cliEntry;
	// Drop Electron's environment. The child is a normal Node process running the existing host.
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(input.env)) {
		if (value === undefined || key.startsWith("ELECTRON_")) continue;
		env[key] = value;
	}
	return {
		nodeExecutable: input.nodeExecutable,
		args: [cli, "web", "--port", "0"],
		cwd: input.cwd,
		env,
		entries: [cli],
	};
}

/** Working directory for the host: an explicit project, otherwise the launching process directory. */
export function hostWorkingDirectory(env: NodeJS.ProcessEnv, cwd: string): string {
	const override = env.AMAZME_GUI_CWD;
	if (override !== undefined && override.length > 0) return override;
	return env.INIT_CWD ?? cwd;
}

export function missingHostEntry(launch: WebHostLaunch): string | undefined {
	return launch.entries.find((entry) => !existsSync(entry));
}
