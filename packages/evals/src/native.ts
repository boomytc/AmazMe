import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DocumentationVariant, EvalTask } from "./plan.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const vitest = resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
export type NativeContext = { artifactDirectory: string; provider: string; model: string; runsPerVariant: number };
export function requireEvalProfile(provider: string): void {
	if (provider !== "faux" && !process.env.AMAZME_EVAL_PROFILE)
		throw new Error("Set AMAZME_EVAL_PROFILE to an existing Python credential profile.");
}
function execute(context: NativeContext, variant: DocumentationVariant, args: string[]): number {
	const result = spawnSync(process.execPath, [vitest, ...args], {
		cwd: packageRoot,
		stdio: "inherit",
		env: {
			...process.env,
			AMAZME_EVAL_VARIANT: variant,
			AMAZME_PROVIDER: context.provider,
			AMAZME_MODEL: context.model,
			AMAZME_EVAL_RUNS_PER_VARIANT: String(context.runsPerVariant),
		},
	});
	if (result.error) throw result.error;
	return result.status ?? 1;
}
export function discoverCases(
	context: NativeContext,
	variant: DocumentationVariant,
	files: readonly string[],
	filters: readonly string[],
): string {
	const directory = join(context.artifactDirectory, "discovery", variant);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const output = join(directory, "discovered-tests.json");
	if (
		execute(context, variant, [
			"list",
			"--config",
			"vitest.evals.config.ts",
			"--project",
			"docs",
			...files,
			...filters,
			`--json=${output}`,
		]) !== 0
	)
		throw new Error(`${variant} eval discovery failed.`);
	return output;
}
export function runTask(context: NativeContext, task: EvalTask): string | undefined {
	const identity = JSON.stringify([task.evalSet, task.caseId, task.variant, task.model, task.runNumber]);
	const directory = join(context.artifactDirectory, "tasks", createHash("sha256").update(identity).digest("hex"));
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const report = join(directory, "vitest.json");
	const exactName = `^${`${task.evalSet} ${task.caseId}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
	execute(context, task.variant, [
		"run",
		"--config",
		"vitest.evals.config.ts",
		"--project",
		"docs",
		task.file,
		"--testNamePattern",
		exactName,
		"--reporter=vitest-evals/reporter",
		"--reporter=json",
		`--outputFile=${report}`,
	]);
	return existsSync(report) ? report : undefined;
}
