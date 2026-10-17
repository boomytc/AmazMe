import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasDurableSession, selectSession } from "../src/durable/sessions.ts";

describe("durable session selection", () => {
	let directory: string;
	let cwd: string;
	let sessionDir: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "amazme-durable-sessions-"));
		cwd = join(directory, "project");
		sessionDir = join(directory, "sessions");
		await mkdir(cwd);
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("opens one exact session directory", async () => {
		const created = await selectSession(cwd, false, { sessionDir });
		expect(created.database).toBeDefined();
		await created.release();
		await writeFile(created.database!, "");

		const opened = await selectSession(cwd, false, { sessionDir, sessionDirectory: created.directory });
		expect(opened.id).toBe(basename(created.directory!));
		expect(opened.database).toBeDefined();
		expect(basename(opened.database!)).toBe("session.sqlite");
		expect(opened.created).toBe(false);
		await opened.release();
	});

	it("ignores empty session directories when continuing", async () => {
		expect(await hasDurableSession(cwd, { sessionDir })).toBe(false);

		const created = await selectSession(cwd, false, { sessionDir });
		await created.release();
		await writeFile(created.database!, "");
		const orphan = join(dirname(created.directory!), "9999999999999-00000000-0000-4000-8000-000000000000");
		await mkdir(orphan);
		expect(await hasDurableSession(cwd, { sessionDir })).toBe(true);
		const continued = await selectSession(cwd, true, { sessionDir });
		expect(continued.id).toBe(created.id);
		await continued.release();
	});

	it("rejects an exact directory without a database or with --no-session", async () => {
		const missing = join(directory, "missing");
		await mkdir(missing);
		await expect(selectSession(cwd, false, { sessionDirectory: missing })).rejects.toThrow("Not a Durable session directory");
		await expect(selectSession(cwd, false, { noSession: true, sessionDirectory: missing })).rejects.toThrow(
			"cannot be combined",
		);
	});
});
