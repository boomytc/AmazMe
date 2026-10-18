import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertSessionCwdExists,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
} from "../src/core/session-cwd.ts";

function createTempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("session cwd handling", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		for (const path of cleanupPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	it("detects a missing stored cwd when a session file is present", () => {
		const fallbackCwd = createTempDir("amazme-session-cwd-fallback");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionFile = join(fallbackCwd, "session.jsonl");
		cleanupPaths.push(fallbackCwd);

		const issue = getMissingSessionCwdIssue(
			{ getCwd: () => missingCwd, getSessionFile: () => sessionFile },
			fallbackCwd,
		);
		expect(issue).toEqual({
			sessionFile,
			sessionCwd: missingCwd,
			fallbackCwd,
		});
	});

	it("ignores an in-memory session and an existing cwd", () => {
		const fallbackCwd = createTempDir("amazme-session-cwd-present");
		cleanupPaths.push(fallbackCwd);
		expect(getMissingSessionCwdIssue({ getCwd: () => fallbackCwd, getSessionFile: () => undefined }, fallbackCwd)).toBeUndefined();
		expect(
			getMissingSessionCwdIssue(
				{ getCwd: () => fallbackCwd, getSessionFile: () => join(fallbackCwd, "session.jsonl") },
				fallbackCwd,
			),
		).toBeUndefined();
	});

	it("throws before continuing when the stored cwd is missing", () => {
		const fallbackCwd = createTempDir("amazme-session-cwd-assert");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		cleanupPaths.push(fallbackCwd);
		expect(() =>
			assertSessionCwdExists(
				{ getCwd: () => missingCwd, getSessionFile: () => join(fallbackCwd, "session.jsonl") },
				fallbackCwd,
			),
		).toThrow(MissingSessionCwdError);
	});
});
