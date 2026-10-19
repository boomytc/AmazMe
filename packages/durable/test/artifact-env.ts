/**
 * Shared helpers for durable tests that need an `ExecutionEnv.artifactDirectory`.
 * The directory is removed via Vitest `onTestFinished` so temp dirs do not accumulate.
 */
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { NodeExecutionEnv, type NodeExecutionEnvOptions } from "../src/env/node.ts";

export type ArtifactEnv = {
	readonly root: string;
	readonly cwd: string;
	readonly artifactDirectory: string;
	readonly env: NodeExecutionEnv;
};

/**
 * Creates a temp tree with `cwd/` and `artifacts/` (the required host-injected artifact directory).
 * Removed automatically when the current test finishes.
 */
export async function createArtifactEnv(
	options: Omit<NodeExecutionEnvOptions, "cwd" | "artifactDirectory"> & {
		readonly prefix?: string;
		readonly cwd?: string;
	} = {},
): Promise<ArtifactEnv> {
	const { prefix = "amazme-durable-artifact-", cwd: cwdOption, ...rest } = options;
	const root = await mkdtemp(join(tmpdir(), prefix));
	const cwd = cwdOption ?? join(root, "cwd");
	const artifactDirectory = join(root, "artifacts");
	await mkdir(cwd, { recursive: true });
	await mkdir(artifactDirectory, { recursive: true });
	onTestFinished(async () => {
		await rm(root, { recursive: true, force: true });
	});
	const env = new NodeExecutionEnv({ cwd, artifactDirectory, ...rest });
	return { root, cwd, artifactDirectory, env };
}

/** Names under `os.tmpdir()` that look like the old leaked codemode temp directories. */
export function amazmeCodemodeTempNames(entries: readonly string[]): string[] {
	return entries.filter((name) => name.startsWith("amazme-codemode-"));
}

/** Snapshot `os.tmpdir()` entries that match `amazme-codemode-*`. */
export async function listAmazmeCodemodeTemps(): Promise<string[]> {
	return amazmeCodemodeTempNames(await readdir(tmpdir()));
}
