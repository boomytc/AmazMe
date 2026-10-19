import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export type CreateTempDirOptions = {
	baseDirectory?: string;
};

/** Create a temp directory removed when this node:test context finishes (`t.after`). */
export function createTempDir(
	t: TestContext,
	prefix: string,
	options: CreateTempDirOptions = {},
): string {
	const baseDirectory = options.baseDirectory ?? tmpdir();
	const dir = mkdtempSync(join(baseDirectory, prefix));
	t.after(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}
