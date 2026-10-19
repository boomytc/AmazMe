import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Check } from "typebox/value";
import { describe, expect, test } from "vitest";
import { readDurableSessionCwd } from "../src/durable/session-cwd.ts";
import { lockSession, resolveExplicitSession, selectSession } from "../src/durable/sessions.ts";
import { createSession as createCatalogSession, listSessions } from "../src/host/session-catalog.ts";
import {
	classifySessionDatabaseError,
	findSessionOpenError,
	lockSessionDatabase,
	openSessionStorage,
	SessionOpenError,
} from "../src/durable/session-database.ts";
import { sessionOpenErrorText } from "../src/host/session-database-error.ts";
import { SessionDatabaseUnavailableError } from "../src/host/session-worker-manager.ts";
import { SessionWorkerEventSchema } from "../src/host/session-worker.ts";
import {
	BROKEN_SESSION_DATABASES,
	snapshotDirectory,
	writeBrokenSessionDatabase,
	writeCrashedCurrentSessionDatabase,
	writeCurrentSessionDatabase,
} from "./session-database-fixtures.ts";
import { createTempDir } from "./temp-dir.ts";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const cliPath = resolve(__dirname, "../src/cli.ts");
const SESSION_NAME = "1760000000000-00000000-0000-4000-8000-000000000001";

/** Open `path` the way hosts do: under its session directory's lock, released again afterwards. */
async function openLocked(path: string) {
	const lease = await lockSessionDatabase(dirname(path), path, lockSession);
	try {
		return await openSessionStorage(lease);
	} finally {
		await lease.release();
	}
}

describe("opening a session database that cannot be used", () => {
	test.each(BROKEN_SESSION_DATABASES)("$fixture is refused as $kind without touching any file", async ({ fixture, kind }) => {
		const directory = join(createTempDir("amazme-session-db-"), "session");
		const path = await writeBrokenSessionDatabase(directory, fixture);
		const before = await snapshotDirectory(directory);
		expect(Object.keys(before)).toEqual(
			fixture === "wal-newer-schema" ? ["session.sqlite", "session.sqlite-wal"] : ["session.sqlite"],
		);

		const error = await openLocked(path).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(SessionOpenError);
		const typed = error as SessionOpenError;
		expect(typed.kind).toBe(kind);
		expect(typed.path).toBe(path);
		expect(typed.message).toContain(path);
		expect(typed.message).toMatch(/Reason: /u);
		expect(typed.message).toMatch(/What to do: /u);
		expect(typed.message).toContain("did not create a new session");
		// Byte-identical, and no `-wal`, `-shm`, or journal appeared.
		expect(await snapshotDirectory(directory)).toEqual(before);

		// The session directory reader used before `--session` takes its lock goes through the same entry.
		await expect(readDurableSessionCwd(directory)).rejects.toMatchObject({ kind, path });
		expect(await snapshotDirectory(directory)).toEqual(before);
	});

	test.each(["current", "wal-newer-schema"] as const)(
		"removes a .preflight-* directory a killed open left behind (%s database)",
		async (fixture) => {
			const directory = join(createTempDir("amazme-session-db-"), "session");
			const path =
				fixture === "current"
					? await writeCurrentSessionDatabase(directory)
					: await writeBrokenSessionDatabase(directory, fixture);
			const database = await snapshotDirectory(directory);
			await mkdir(join(directory, ".preflight-AbC123"));
			await writeFile(join(directory, ".preflight-AbC123", "database.sqlite"), "copy left by SIGKILL");
			await writeFile(join(directory, ".preflight-AbC123", "database.sqlite-wal"), "copy left by SIGKILL");

			if (fixture === "current") await (await openLocked(path)).close(BACKGROUND_CONTEXT);
			else await expect(openLocked(path)).rejects.toMatchObject({ kind: "newer-schema" });
			// The leftover is gone, nothing new appeared, and session.sqlite, -wal, -shm are byte-identical.
			expect(await snapshotDirectory(directory)).toEqual(database);
		},
	);

	test("a .preflight-* directory is not mistaken for a session by session discovery", async () => {
		const scratch = await realpath(createTempDir("amazme-session-db-scan-"));
		const project = join(scratch, "project");
		await mkdir(project);
		const sessionsDir = join(scratch, "sessions");
		const root = join(sessionsDir, createHash("sha256").update(project).digest("hex").slice(0, 24));
		const directory = join(root, SESSION_NAME);
		await writeCurrentSessionDatabase(directory);
		await mkdir(join(directory, ".preflight-AbC123"));
		await writeFile(join(directory, ".preflight-AbC123", "database.sqlite"), "copy left by SIGKILL");
		const catalogRoot = join(scratch, "catalog");
		await createCatalogSession(catalogRoot, { id: "demo-1", cwd: project });
		await writeCurrentSessionDatabase(join(catalogRoot, "demo-1"));
		await mkdir(join(catalogRoot, "demo-1", ".preflight-AbC123"));

		await expect(resolveExplicitSession(project, SESSION_NAME, { sessionDir: sessionsDir })).resolves.toMatchObject({
			directory,
		});
		await expect(resolveExplicitSession(project, ".preflight-AbC123", { sessionDir: sessionsDir })).rejects.toThrow(
			"No durable session matches",
		);
		const selected = await selectSession(project, true, { sessionDir: sessionsDir });
		try {
			expect(selected.directory).toBe(directory);
		} finally {
			await selected.release();
		}
		expect((await listSessions(catalogRoot)).map((session) => session.id)).toEqual(["demo-1"]);
	});

	test("explains each kind with a remedy", async () => {
		const path = "/sessions/demo/session.sqlite";
		const newer = new SessionOpenError({ kind: "newer-schema", path, detail: "", version: 99, supportedVersion: 2 });
		expect(newer.message).toBe(
			[
				`Cannot open session database ${path}`,
				"Reason: it was written by a newer version of AmazMe (schema version 99; this version supports up to 2).",
				"What to do: Upgrade AmazMe to the latest version, then open this session again. AmazMe did not create a new session in its place.",
			].join("\n"),
		);
		const damaged = new SessionOpenError({ kind: "not-a-database", path, detail: "file is not a database" });
		expect(damaged.message).toContain("not a SQLite database");
		expect(damaged.message).toContain("Restore the file from a backup, or move the session directory aside");
		const migration = new SessionOpenError({ kind: "migration-failed", path, detail: "table tasks_v2 already exists" });
		expect(migration.message).toContain("rolled back (table tasks_v2 already exists)");
	});

	test("crosses the Session worker boundary with its kind and path", () => {
		const original = new SessionOpenError({
			kind: "newer-schema",
			path: "/sessions/demo/session.sqlite",
			detail: "SQLite schema version 99 is newer than supported version 2",
			version: 99,
			supportedVersion: 2,
		});
		const event = JSON.parse(
			JSON.stringify({
				type: "worker_failed",
				token: "token",
				sessionKey: "/sessions/demo",
				message: original.message,
				sessionOpenError: original,
			}),
		);
		expect(Check(SessionWorkerEventSchema, event)).toBe(true);
		const rebuilt = SessionOpenError.fromJSON(event.sessionOpenError);
		expect(rebuilt?.toJSON()).toEqual(original.toJSON());
		expect(rebuilt?.message).toBe(original.message);
		expect(SessionOpenError.fromJSON({ kind: "unknown", path: "/x", detail: "" })).toBeUndefined();

		// What the server reports to a client: a Chord error whose reason names the kind, and the readable message.
		const reported = new SessionDatabaseUnavailableError(rebuilt!);
		expect(reported).toMatchObject({
			code: "unavailable",
			reason: "session_database_newer_schema",
			kind: "newer-schema",
			path: "/sessions/demo/session.sqlite",
		});
		expect(sessionOpenErrorText(reported)).toBe(original.message);
		expect(sessionOpenErrorText(new Error("other"))).toBeUndefined();
	});

	test("finds the typed error behind startup cleanup failures and leaves unrelated errors alone", () => {
		const typed = new SessionOpenError({ kind: "corrupt", path: "/s/session.sqlite", detail: "database disk image is malformed" });
		expect(findSessionOpenError(new AggregateError([typed, new Error("cleanup")], "startup and cleanup failed"))).toBe(typed);
		expect(findSessionOpenError(new Error("wrapped", { cause: typed }))).toBe(typed);
		expect(findSessionOpenError(new Error("other"))).toBeUndefined();
		const busy = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
		expect(classifySessionDatabaseError(busy, "/s/session.sqlite")).toBeUndefined();
		const corrupt = Object.assign(new Error("database disk image is malformed"), { code: "ERR_SQLITE_ERROR", errcode: 11 });
		expect(classifySessionDatabaseError(corrupt, "/s/session.sqlite")?.kind).toBe("corrupt");
	});
});

describe.skipIf(process.platform === "win32")("two processes opening one session", () => {
	const openerPath = resolve(import.meta.dirname, "fixtures/open-session-locked.ts");

	async function opener(directory: string, mode: "open" | "cwd", holdMs: number) {
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, openerPath, directory, mode, String(holdMs)], {
			env: { ...process.env, NODE_NO_WARNINGS: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
		const [code] = (await once(child, "close")) as [number | null];
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		return JSON.parse(stdout) as { result: string; message?: string };
	}

	test("with a non-empty -wal, the preflight copy of one is never deleted by the other", async () => {
		const scratch = await realpath(createTempDir("amazme-session-db-concurrent-"));
		for (let round = 0; round < 6; round++) {
			const directory = join(scratch, `session-${round}`);
			const path = await writeCrashedCurrentSessionDatabase(directory);
			// Both openers start together; the copy branch runs because the -wal holds an uncheckpointed commit.
			const results = await Promise.all([
				opener(directory, "open", 300),
				opener(directory, round % 2 === 0 ? "open" : "cwd", 300),
			]);
			for (const result of results) {
				// Existing lock semantics: the loser gets "already open"; never a SessionOpenError or a missing file.
				expect(["opened", "locked"], JSON.stringify(result)).toContain(result.result);
			}
			expect(results.some((result) => result.result === "opened")).toBe(true);
			const entries = await readdir(directory);
			expect(entries.filter((entry) => entry.startsWith(".preflight-"))).toEqual([]);
			expect(entries).toContain("session.sqlite");
			await (await openLocked(path)).close(BACKGROUND_CONTEXT);
		}
	}, 120_000);
});

describe.skipIf(process.platform === "win32")("CLI with a session database that cannot be used", () => {
	/** Run the source CLI with stdin closed, so print mode does not wait for piped input. */
	async function runCli(cwd: string, agentDir: string, args: readonly string[]) {
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...args], {
			cwd,
			env: { ...process.env, AMAZME_CODING_AGENT_DIR: agentDir, AMAZME_OFFLINE: "1", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		try {
			const [code] = (await once(child, "close")) as [number | null];
			return { code, stdout, stderr };
		} finally {
			clearTimeout(timer);
		}
	}

	test.each(BROKEN_SESSION_DATABASES)(
		"$fixture: --continue and --session exit non-zero with a readable message and leave the files alone",
		async ({ fixture }) => {
			const scratch = await realpath(createTempDir("amazme-session-db-cli-"));
			const agentDir = join(scratch, "agent");
			const sessionsDir = join(scratch, "sessions");
			// The session root for this cwd; `--continue` picks the newest session in it.
			const project = join(scratch, "project");
			await mkdir(project);
			const cwd = await realpath(project);
			const root = join(sessionsDir, createHash("sha256").update(cwd).digest("hex").slice(0, 24));
			const directory = join(root, SESSION_NAME);
			const path = await writeBrokenSessionDatabase(directory, fixture);
			const before = await snapshotDirectory(sessionsDir);

			for (const args of [
				["--session-dir", sessionsDir, "--continue", "-p", "hello"],
				["--session", directory, "-p", "hello"],
			]) {
				const result = await runCli(cwd, agentDir, args);
				expect(result.code, result.stderr).toBe(1);
				expect(result.stderr).toContain(`Cannot open session database ${path}`);
				expect(result.stderr).toMatch(/Reason: .+/u);
				expect(result.stderr).toMatch(/What to do: .+/u);
				expect(result.stderr).not.toMatch(/^\s+at /mu);
				// No new session directory, and every file byte-identical (no new `-wal`/`-shm`).
				expect(await snapshotDirectory(sessionsDir)).toEqual(before);
				expect(await readdir(root)).toEqual([SESSION_NAME]);
			}
		},
		120_000,
	);
});
