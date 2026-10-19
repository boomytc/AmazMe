/**
 * Environment for a child Node process whose stderr a test asserts on.
 *
 * A developer shell can carry `NODE_NO_WARNINGS=1`, or `--no-warnings` and friends in `NODE_OPTIONS`. Inherited by the
 * child, they hide runtime warnings (node:sqlite's ExperimentalWarning, for one) that a user's terminal and CI do show,
 * so a stderr assertion passes locally and fails in CI. This starts from `process.env`, applies `overrides`, then drops
 * every inherited way to silence or redirect warnings, so the child prints what a clean environment would print.
 *
 * Every test that spawns a process and asserts on its stderr uses this; child-process-env.test.ts enforces that.
 */
export function childProcessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
	delete env.NODE_NO_WARNINGS;
	delete env.NODE_REDIRECT_WARNINGS;
	const options = env.NODE_OPTIONS === undefined ? undefined : withoutWarningFlags(env.NODE_OPTIONS);
	if (options === undefined || options === "") delete env.NODE_OPTIONS;
	else env.NODE_OPTIONS = options;
	for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
	return env;
}

/** Flags that turn warnings off. */
const SILENCING_FLAGS = new Set(["--no-warnings", "--no-deprecation"]);
/** Flags that turn some warnings off, or send them away from stderr, and take a value. */
const SILENCING_FLAGS_WITH_VALUE = new Set(["--disable-warning", "--redirect-warnings"]);

/** `NODE_OPTIONS` without the warning flags; other options keep their order. */
export function withoutWarningFlags(nodeOptions: string): string {
	const kept: string[] = [];
	const tokens = nodeOptions.split(/\s+/u).filter((token) => token !== "");
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
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
