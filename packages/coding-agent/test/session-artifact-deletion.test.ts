import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionDeletionTarget } from "../src/modes/interactive/components/session-selector.ts";
import { createTempDir } from "./temp-dir.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("resolveSessionDeletionTarget", () => {
	it("deletes the session directory when given session.sqlite so artifacts go with it", async () => {
		const root = createTempDir("amazme-session-delete-");
		directories.push(root);
		const sessionDir = join(root, "session-id");
		await mkdir(sessionDir);
		const sqlite = join(sessionDir, "session.sqlite");
		await writeFile(sqlite, "");
		await mkdir(join(sessionDir, "artifacts"));
		expect(await resolveSessionDeletionTarget(sqlite)).toBe(sessionDir);
		expect(await resolveSessionDeletionTarget(sessionDir)).toBe(sessionDir);
	});

	it("keeps legacy JSONL paths as single-file deletes", async () => {
		const root = createTempDir("amazme-jsonl-delete-");
		directories.push(root);
		const jsonl = join(root, "session.jsonl");
		await writeFile(jsonl, "{}\n");
		expect(await resolveSessionDeletionTarget(jsonl)).toBe(jsonl);
	});
});
