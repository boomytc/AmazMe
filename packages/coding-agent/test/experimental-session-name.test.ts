import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	createSession,
	mergeTrackedSession,
	normalizeSessionName,
	readSession,
	writeSessionName,
	type SessionCatalogMetadata,
} from "../src/host/session-catalog.ts";
import { createTempDir } from "./temp-dir.ts";

describe("session display names", () => {
	test("normalizes newlines the way /name does", () => {
		expect(normalizeSessionName("a\nb\r\nc")).toBe("a b c");
		expect(normalizeSessionName("  ")).toBe("");
	});

	test("stores the name where the roster reads it and clears a blank one", async () => {
		const dir = createTempDir("session-name-");
		try {
			const created = await createSession(dir, { id: "s1", cwd: "/work", name: "first" });
			expect((await readSession(dir, "s1"))?.name).toBe("first");
			const renamed = await writeSessionName(dir, "s1", "weekly\nreport");
			expect(renamed.name).toBe("weekly report");
			expect((await readSession(dir, "s1"))?.nameSource).toBe("manual");
			const file = JSON.parse(await readFile(join(created.path, "meta.json"), "utf8")) as { name?: string };
			expect(file.name).toBe("weekly report");
			const cleared = await writeSessionName(dir, "s1", "  ");
			expect(cleared.name).toBeUndefined();
			expect((await readSession(dir, "s1"))?.nameSource).toBe("manual");
			const after = JSON.parse(await readFile(join(created.path, "meta.json"), "utf8")) as { name?: string };
			expect(after.name).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("the roster name is the catalog name, and a name on the worker row is ignored", () => {
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
		expect(mergeTrackedSession(undefined, { ...nameless, name: "shipped" }).name).toBeUndefined();
		expect(mergeTrackedSession({ ...catalog, name: undefined }, { ...nameless, name: "shipped" }).name).toBeUndefined();
		expect(mergeTrackedSession(undefined, nameless).name).toBeUndefined();
		expect(mergeTrackedSession({ ...catalog, name: undefined }, nameless).name).toBeUndefined();
		expect(mergeTrackedSession({ ...nameless, nameSource: "manual" }, { ...catalog, nameSource: "automatic" }))
			.toEqual({ ...nameless, nameSource: "manual" });
	});

});
