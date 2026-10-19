import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, type TestContext } from "node:test";

export type CreateTempDirOptions = {
	baseDirectory?: string;
};

/** Schedules cleanup after the current test (`t.after`) or after the suite (`"suite"` → module `after`). */
export type TempDirContext = Pick<TestContext, "after"> | "suite";

/** Create a temp directory removed when this node:test context finishes. */
export function createTempDir(
	t: TempDirContext,
	prefix: string,
	options: CreateTempDirOptions = {},
): string {
	const baseDirectory = options.baseDirectory ?? tmpdir();
	const dir = mkdtempSync(join(baseDirectory, prefix));
	const cleanup = () => {
		rmSync(dir, { recursive: true, force: true });
	};
	if (t === "suite") after(cleanup);
	else t.after(cleanup);
	return dir;
}
