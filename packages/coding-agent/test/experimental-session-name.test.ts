import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	createSession,
	mergeTrackedSession,
	normalizeSessionName,
	readSession,
	writeSessionName,
	type SessionCatalogMetadata,
} from "../src/experimental/session-catalog.ts";
import { writeSessionMirror } from "../src/experimental/session-store.ts";

describe("session display names", () => {
	test("normalizes newlines the way /name does", () => {
		expect(normalizeSessionName("a\nb\r\nc")).toBe("a b c");
		expect(normalizeSessionName("  ")).toBe("");
	});

	test("stores the name where the roster reads it and clears a blank one", async () => {
		const dir = await mkdtemp(join(tmpdir(), "session-name-"));
		try {
			const created = await createSession(dir, { id: "s1", cwd: "/work", name: "first" });
			expect((await readSession(dir, "s1"))?.name).toBe("first");
			const renamed = await writeSessionName(dir, "s1", "weekly\nreport");
			expect(renamed.name).toBe("weekly report");
			const file = JSON.parse(await readFile(join(created.path, "meta.json"), "utf8")) as { name?: string };
			expect(file.name).toBe("weekly report");
			const cleared = await writeSessionName(dir, "s1", "  ");
			expect(cleared.name).toBeUndefined();
			const after = JSON.parse(await readFile(join(created.path, "meta.json"), "utf8")) as { name?: string };
			expect(after.name).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a catalog name wins, and a worker name is only a fallback when the catalog has none", () => {
		const catalog: SessionCatalogMetadata = {
			id: "s1",
			createdAt: 1,
			cwd: "/work",
			path: "/sessions/s1",
			name: "weekly report",
		};
		const nameless: SessionCatalogMetadata = { id: "s1", createdAt: 1, cwd: "/work", path: "/sessions/s1" };
		expect(mergeTrackedSession(catalog, nameless).name).toBe("weekly report");
		expect(mergeTrackedSession(catalog, { ...nameless, name: "  " }).name).toBe("weekly report");
		expect(mergeTrackedSession(catalog, { ...nameless, name: "shipped" }).name).toBe("weekly report");
		expect(mergeTrackedSession(undefined, { ...nameless, name: "shipped" }).name).toBe("shipped");
		expect(mergeTrackedSession({ ...catalog, name: undefined }, { ...nameless, name: "shipped" }).name).toBe("shipped");
		expect(mergeTrackedSession(undefined, nameless).name).toBeUndefined();
		expect(mergeTrackedSession({ ...catalog, name: undefined }, nameless).name).toBeUndefined();
	});

	test("copies the name into the terminal mirror as session_info", async () => {
		const dir = await mkdtemp(join(tmpdir(), "session-mirror-"));
		const path = join(dir, "session.jsonl");
		try {
			await writeSessionMirror({
				path,
				sessionId: "s1",
				cwd: "/work",
				createdAt: 1_700_000_000_000,
				name: "weekly report",
				entries: [],
			});
			expect(SessionManager.open(path).getSessionName()).toBe("weekly report");
			await writeSessionMirror({
				path,
				sessionId: "s1",
				cwd: "/work",
				createdAt: 1_700_000_000_000,
				entries: [],
			});
			expect(SessionManager.open(path).getSessionName()).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
