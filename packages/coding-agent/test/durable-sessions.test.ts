import { access, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasDurableSession, lockSession, selectSession, SESSION_LOCK_STALE_MS } from "../src/durable/sessions.ts";
import type { SessionLocation } from "../src/durable/sessions.ts";
import { createTempDir } from "./temp-dir.ts";

describe("durable session selection", () => {
	let directory: string;
	let cwd: string;
	let sessionDir: string;

	beforeEach(async () => {
		directory = createTempDir("amazme-durable-sessions-");
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

	it("fails immediately when another open holds a fresh session lock", async () => {
		const held = await persistSession();
		try {
			const started = Date.now();
			await expect(selectSession(cwd, true, { sessionDir })).rejects.toThrow(alreadyOpenMessage(held.directory!));
			expect(Date.now() - started).toBeLessThan(2_000);
			expect(await lockfile.check(held.directory!, { realpath: false, stale: SESSION_LOCK_STALE_MS })).toBe(true);
		} finally {
			await held.release();
		}
		expect(await lockfile.check(held.directory!, { realpath: false, stale: SESSION_LOCK_STALE_MS })).toBe(false);
	});

	it("fails immediately when an explicit session directory lock is fresh", async () => {
		const created = await persistSession();
		await created.release();
		const held = await selectSession(cwd, false, { sessionDir, sessionDirectory: created.directory });
		try {
			const started = Date.now();
			await expect(selectSession(cwd, false, { sessionDir, sessionDirectory: created.directory })).rejects.toThrow(
				alreadyOpenMessage(held.directory!),
			);
			expect(Date.now() - started).toBeLessThan(2_000);
			expect(await lockfile.check(held.directory!, { realpath: false, stale: SESSION_LOCK_STALE_MS })).toBe(true);
		} finally {
			await held.release();
		}
	});

	it("takes over a session lock older than 10 seconds", async () => {
		const created = await persistSession();
		await created.release();
		await plantLock(created.directory!, SESSION_LOCK_STALE_MS + 1_500);
		const taken = await selectSession(cwd, true, { sessionDir });
		try {
			expect(taken.id).toBe(created.id);
			expect(taken.directory).toBe(created.directory);
		} finally {
			await taken.release();
		}
	});

	it("does not rewrite lock errors other than ELOCKED", async () => {
		const missing = join(directory, "absent-parent", "session");
		let caught: unknown;
		try {
			await lockSession(missing);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		if (!(caught instanceof Error) || !("code" in caught)) throw new Error("expected an errno exception");
		expect(caught.code).toBe("ENOENT");
		expect(caught.message).not.toContain("already open in another process");
	});

	it("keeps the session lock stale threshold at 10 seconds", async () => {
		expect(SESSION_LOCK_STALE_MS).toBe(10_000);
		const created = await persistSession();
		await created.release();
		await plantLock(created.directory!, SESSION_LOCK_STALE_MS - 3_000);
		const started = Date.now();
		await expect(selectSession(cwd, true, { sessionDir })).rejects.toThrow(alreadyOpenMessage(created.directory!));
		expect(Date.now() - started).toBeLessThan(2_000);
		await access(`${created.directory!}.lock`);
	});

	async function persistSession(): Promise<SessionLocation> {
		const created = await selectSession(cwd, false, { sessionDir });
		await writeFile(created.database!, "");
		return created;
	}
});

function alreadyOpenMessage(directory: string): string {
	return (
		`Session is already open in another process: ${directory}. ` +
		"If that process crashed, wait about 10 seconds and run again to take over the session."
	);
}

/** A lock directory left behind with an old mtime, as a crashed process would. */
async function plantLock(directory: string, ageMs: number): Promise<void> {
	const lock = `${directory}.lock`;
	await mkdir(lock);
	const when = new Date(Date.now() - ageMs);
	await utimes(lock, when, when);
}
