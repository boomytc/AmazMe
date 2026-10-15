import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSession, listSessions } from "../src/host/session-catalog.ts";

vi.mock("node:fs/promises", async importOriginal => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return { ...original, readFile: vi.fn(original.readFile), readdir: vi.fn(original.readdir) };
});

const folders: string[] = [];
const pending: Promise<unknown>[] = [];
let releaseReads: (() => void) | undefined;

beforeEach(() => {
	vi.mocked(readFile).mockReset();
	vi.mocked(readdir).mockReset();
});
afterEach(async () => {
	releaseReads?.();
	releaseReads = undefined;
	await Promise.allSettled(pending.splice(0));
	vi.mocked(readFile).mockReset();
	vi.mocked(readdir).mockReset();
	await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
	const folder = await mkdtemp(join(tmpdir(), "amazme-session-catalog-"));
	folders.push(folder);
	return folder;
}

async function populate(folder: string, count: number): Promise<string[]> {
	const ids = Array.from({ length: count }, (_, index) => `session-${String(count - index).padStart(3, "0")}`);
	await Promise.all(ids.map(id => createSession(folder, { id, cwd: folder, name: id })));
	const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	return original.readdir(folder);
}

/** Observe real reads; the optional barrier keeps metadata operations in flight without timing assumptions. */
async function observeReads(holdMetadata: boolean, failedPaths: ReadonlySet<string> = new Set()) {
	const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	const saturated = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	releaseReads = released.resolve;
	const observed = { active: 0, peak: 0, metadata: 0 };
	let activeMetadata = 0;
	async function observe<T>(path: string, metadata: boolean, read: () => Promise<T>): Promise<T> {
		observed.active++;
		observed.peak = Math.max(observed.peak, observed.active);
		if (metadata) { observed.metadata++; activeMetadata++; }
		if (activeMetadata >= 3) saturated.resolve();
		try {
			if (metadata && holdMetadata) await released.promise;
			if (failedPaths.has(path)) throw Object.assign(new Error(`unreadable ${path}`), { code: "EACCES" });
			return await read();
		} finally { observed.active--; if (metadata) activeMetadata--; }
	}
	vi.mocked(readFile).mockImplementation((path, options) => observe(String(path), true, () => original.readFile(path, options)));
	vi.mocked(readdir).mockImplementation((path, options) => observe(String(path), false, () => original.readdir(path, options)));
	return { observed, saturated: saturated.promise, release: released.resolve };
}

describe("native session catalog read budget", () => {
	test("two listings share at most three reads and retain every session in directory order", async () => {
		const folder = await directory();
		const expected = await populate(folder, 12);
		const reads = await observeReads(true);
		const first = listSessions(folder);
		const second = listSessions(folder);
		pending.push(first, second);
		await reads.saturated;
		expect(reads.observed.active).toBe(3);
		expect(reads.observed.peak).toBe(3);
		reads.release();
		const [left, right] = await Promise.all([first, second]);
		expect(left.map(session => session.id)).toEqual(expected);
		expect(right).toEqual(left);
		expect(reads.observed.metadata).toBe(24);
		expect(reads.observed.peak).toBe(3);
		expect(reads.observed.active).toBe(0);
	});

	test("directory errors and skipped metadata release slots for later complete listings", async () => {
		const folder = await directory();
		const expected = await populate(folder, 8);
		await mkdir(join(folder, "missing-metadata"));
		await mkdir(join(folder, "invalid-metadata"));
		await writeFile(join(folder, "invalid-metadata", "meta.json"), "{not-json");
		const denied = new Set([folder]);
		const reads = await observeReads(false, denied);
		await expect(listSessions(folder)).rejects.toThrow("unreadable");
		expect(reads.observed.active).toBe(0);
		denied.delete(folder);
		denied.add(join(folder, expected[0]!, "meta.json"));
		const partial = await listSessions(folder);
		expect(partial.map(session => session.id)).toEqual(expected.slice(1));
		expect(reads.observed.active).toBe(0);
		denied.clear();
		const [first, second] = await Promise.all([listSessions(folder), listSessions(folder)]);
		expect(first.map(session => session.id)).toEqual(expected);
		expect(second).toEqual(first);
		expect(reads.observed.peak).toBeLessThanOrEqual(3);
		expect(reads.observed.active).toBe(0);
	});
});
