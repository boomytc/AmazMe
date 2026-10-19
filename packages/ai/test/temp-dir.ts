import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/** Create a temp directory that is removed when the current vitest test finishes. */
export function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	onTestFinished(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}
