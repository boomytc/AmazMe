/**
 * Vitest setup file, run first in every test worker: drop every inherited way to silence or redirect Node's warnings.
 *
 * A developer shell can carry `NODE_NO_WARNINGS=1`, or `--no-warnings` and friends in `NODE_OPTIONS`. Child processes
 * started by tests inherit `process.env`, so those settings would hide runtime warnings (node:sqlite's
 * ExperimentalWarning, for one) that a user's terminal and CI show, and a stderr assertion would pass locally and fail
 * in CI. Cleaning `process.env` here gives every child the environment a clean shell would.
 *
 * This only changes what children inherit; the worker itself keeps the settings it started with. It exports nothing,
 * so a test cannot load it by importing it and hide that the setup file did not run; setup-warnings-env.test.ts
 * exercises it with `node --import`.
 */

/** Flags that turn warnings off. */
const SILENCING_FLAGS = new Set(["--no-warnings", "--no-deprecation"]);
/** Flags that turn some warnings off, or send them away from stderr, and take a value. */
const SILENCING_FLAGS_WITH_VALUE = new Set(["--disable-warning", "--redirect-warnings"]);

/** `NODE_OPTIONS` without the warning flags; other options keep their order. */
function withoutWarningFlags(nodeOptions: string): string {
	const kept: string[] = [];
	const tokens = nodeOptions.split(/\s+/u).filter((token) => token !== "");
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		// Node treats `_` and `-` alike in option names: `--no_warnings` is `--no-warnings`.
		const [name = "", value] = token.split("=", 2);
		const flag = name.startsWith("--") ? `--${name.slice(2).replaceAll("_", "-")}` : name;
		if (SILENCING_FLAGS.has(flag)) continue;
		if (SILENCING_FLAGS_WITH_VALUE.has(flag)) {
			if (value === undefined) index++;
			continue;
		}
		kept.push(token);
	}
	return kept.join(" ");
}

/** Remove the warning switches from `env` in place. */
function cleanWarningsEnv(env: NodeJS.ProcessEnv): void {
	delete env.NODE_NO_WARNINGS;
	delete env.NODE_REDIRECT_WARNINGS;
	if (env.NODE_OPTIONS === undefined) return;
	const options = withoutWarningFlags(env.NODE_OPTIONS);
	if (options === "") delete env.NODE_OPTIONS;
	else env.NODE_OPTIONS = options;
}

cleanWarningsEnv(process.env);
export {};
