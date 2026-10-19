import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createSession, readSession, sessionStoragePath, writeSessionArchive } from "../src/host/session-catalog.ts";
import { createTempDir } from "./temp-dir.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function setup() {
	const directory = createTempDir("session-archive-");
	directories.push(directory);
	const session = await createSession(directory, { id: "archive-test", cwd: directory, name: "Retained history" });
	return { directory, session };
}

test("ordinary archive now records stopped work and restoration clears both markers", async () => {
	const { directory, session } = await setup();
	await writeFile(sessionStoragePath(session), "retained storage");
	const archived = await writeSessionArchive(directory, session.id, true);
	expect(archived.archivedAt).toEqual(expect.any(Number));
	expect(archived.workEndedAt).toEqual(expect.any(Number));
	expect(await readSession(directory, session.id)).toMatchObject(archived);
	const repeated = await writeSessionArchive(directory, session.id, true);
	expect(repeated.archivedAt).toBe(archived.archivedAt);
	expect(repeated.workEndedAt).toBe(archived.workEndedAt);
	const restored = await writeSessionArchive(directory, session.id, false);
	expect(restored.archivedAt).toBeUndefined();
	expect(restored.workEndedAt).toBeUndefined();
	expect(restored.name).toBe("Retained history");
	expect(await readFile(sessionStoragePath(session), "utf8")).toBe("retained storage");
});

test("archiving an old archive keeps its timestamp and adds the compatibility stop marker", async () => {
	const { directory, session } = await setup();
	await writeFile(join(session.path, "meta.json"), JSON.stringify({ ...session, archivedAt: 1 }));
	const archived = await writeSessionArchive(directory, session.id, true);
	expect(archived.archivedAt).toBe(1);
	expect(archived.workEndedAt).toEqual(expect.any(Number));
	const restored = await writeSessionArchive(directory, session.id, false);
	expect(restored.archivedAt).toBeUndefined();
	expect(restored.workEndedAt).toBeUndefined();
});
