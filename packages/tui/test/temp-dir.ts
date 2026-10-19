import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach } from "node:test";

export type CreateTempDirOptions = {
	baseDirectory?: string;
	scope?: "test" | "suite";
};

/** Create a temp directory removed when the current node:test test (or suite) finishes. */
export function createTempDir(
	prefix: string,
	options: CreateTempDirOptions = {},
): string {
	const baseDirectory = options.baseDirectory ?? tmpdir();
	const scope = options.scope ?? "test";
	const dir = mkdtempSync(join(baseDirectory, prefix));
	const cleanup = () => {
		rmSync(dir, { recursive: true, force: true });
	};
	if (scope === "suite") after(cleanup);
	else afterEach(cleanup);
	return dir;
}
