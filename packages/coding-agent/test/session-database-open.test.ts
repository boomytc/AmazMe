import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Check } from "typebox/value";
import { describe, expect, test } from "vitest";
import { readDurableSessionCwd } from "../src/durable/session-cwd.ts";
import {
	classifySessionDatabaseError,
	findSessionOpenError,
	openSessionStorage,
	SessionOpenError,
} from "../src/durable/session-database.ts";
import { sessionOpenErrorText } from "../src/host/session-database-error.ts";
import { SessionDatabaseUnavailableError } from "../src/host/session-worker-manager.ts";
import { SessionWorkerEventSchema } from "../src/host/session-worker.ts";
import { BROKEN_SESSION_DATABASES, snapshotDirectory, writeBrokenSessionDatabase } from "./session-database-fixtures.ts";
import { createTempDir } from "./temp-dir.ts";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const cliPath = resolve(__dirname, "../src/cli.ts");
const SESSION_NAME = "1760000000000-00000000-0000-4000-8000-000000000001";

describe("opening a session database that cannot be used", () => {
	test.each(BROKEN_SESSION_DATABASES)("$fixture is refused as $kind without touching any file", async ({ fixture, kind }) => {
		const directory = join(createTempDir("amazme-session-db-"), "session");
		const path = await writeBrokenSessionDatabase(directory, fixture);
		const before = await snapshotDirectory(directory);
		expect(Object.keys(before)).toEqual(
			fixture === "wal-newer-schema" ? ["session.sqlite", "session.sqlite-wal"] : ["session.sqlite"],
		);

		const error = await openSessionStorage(path).then(
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
