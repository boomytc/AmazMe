import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test(
	"issue triage corpus, durable recovery and local HTTP endpoints work offline",
	{ timeout: 60_000 },
	() => {
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		execFileSync(
			process.execPath,
			[
				"--import",
				"./packages/coding-agent/src/source-resolver.ts",
				"--test",
				"scripts/issues/tests.ts",
			],
			{
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				env,
				stdio: "inherit",
				timeout: 55_000,
			},
		);
	},
);
