import { mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@amazme/chord/context";
import { replicatedState } from "@amazme/chord";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceService, WORKSPACE_PAGE_SIZE } from "../src/host/services/workspace-provider.ts";
import type { WorkspaceOpenInput } from "../src/host/services/workspace.ts";
import { createTempDir } from "./temp-dir.ts";

vi.mock("node:fs/promises", async importOriginal => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return { ...original, stat: vi.fn(original.stat) };
});

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
async function directory(): Promise<string> {
	const folder = createTempDir("amazme-workspace-page-");
	folders.push(folder);
	return folder;
}
async function setup(count = 205) {
	const cwd = await directory();
	await Promise.all(Array.from({ length: count }, (_, index) => writeFile(join(cwd, `file-${String(index).padStart(4, "0")}.txt`), `body-${index}`)));
	const runtime = createWorkspaceService({ cwd }, initial => replicatedState(initial));
	return { cwd, runtime, state: runtime.service.state };
}

describe("bounded workspace directory pages", () => {
	it("limits metadata and replicated rows while covering all names without duplicates", async () => {
		const { cwd, runtime, state } = await setup();
		await mkdir(join(cwd, "z-directory"));
		vi.mocked(stat).mockClear();
		await runtime.service.open(".", BACKGROUND_CONTEXT);
		const first = state.value.view;
		if (first.kind !== "listing") throw new Error("Expected listing");
		expect(first.page).toEqual({ offset: 0, limit: WORKSPACE_PAGE_SIZE, total: 206 });
		expect(first.entries).toHaveLength(100);
		expect(first.entries[0]).toMatchObject({ name: "z-directory", kind: "dir" });
		expect(vi.mocked(stat).mock.calls).toHaveLength(100);
		const names = first.entries.map(entry => entry.name);
		for (const offset of [100, 200]) {
			vi.mocked(stat).mockClear();
			await runtime.service.open({ path: ".", offset }, BACKGROUND_CONTEXT);
			if (state.value.view.kind !== "listing") throw new Error("Expected listing");
			names.push(...state.value.view.entries.map(entry => entry.name));
			expect(vi.mocked(stat).mock.calls.length).toBeLessThanOrEqual(WORKSPACE_PAGE_SIZE);
		}
		expect(names).toHaveLength(206);
		expect(new Set(names).size).toBe(206);
	});

	it("keeps the page on reload and file return, sees new entries, and clamps after deletion", async () => {
		const { cwd, runtime, state } = await setup();
		await runtime.service.open({ path: ".", offset: 100 }, BACKGROUND_CONTEXT);
		await writeFile(join(cwd, "file-new.txt"), "new");
		await runtime.refresh(BACKGROUND_CONTEXT);
		expect(state.value.view).toMatchObject({ kind: "listing", page: { offset: 100, total: 206 } });
		await runtime.service.read("file-0100.txt", BACKGROUND_CONTEXT);
		expect(state.value.view).toMatchObject({ kind: "text", text: "body-100" });
		await runtime.service.open(".", BACKGROUND_CONTEXT);
		expect(state.value.view).toMatchObject({ kind: "listing", page: { offset: 100 } });
		await Promise.all(Array.from({ length: 205 }, (_, index) => rm(join(cwd, `file-${String(index).padStart(4, "0")}.txt`))));
		await runtime.service.open(".", BACKGROUND_CONTEXT);
		expect(state.value.view).toMatchObject({ kind: "listing", page: { offset: 0, total: 1 }, entries: [{ name: "file-new.txt" }] });
	});

	it("does not carry a page into another directory and handles an empty directory", async () => {
		const { cwd, runtime, state } = await setup();
		await mkdir(join(cwd, "nested"));
		await runtime.service.open({ path: ".", offset: 100 }, BACKGROUND_CONTEXT);
		await runtime.service.open("nested", BACKGROUND_CONTEXT);
		expect(state.value.view).toMatchObject({ kind: "listing", path: "nested", entries: [], page: { offset: 0, total: 0 } });
		await runtime.service.open(".", BACKGROUND_CONTEXT);
		expect(state.value.view).toMatchObject({ kind: "listing", page: { offset: 0 } });
	});

	it("captures page arguments before they enter the serialized queue", async () => {
		const { runtime, state } = await setup();
		const input = { path: ".", offset: 100 };
		const operation = runtime.service.open(input, BACKGROUND_CONTEXT);
		input.offset = -100;
		await operation;
		expect(state.value.view).toMatchObject({ kind: "listing", page: { offset: 100 } });
	});

	it("refreshes the directory opened by an earlier queued operation", async () => {
		const { cwd, runtime, state } = await setup(1);
		await mkdir(join(cwd, "nested"));
		await runtime.service.open(".", BACKGROUND_CONTEXT);
		await Promise.all([runtime.service.open("nested", BACKGROUND_CONTEXT), runtime.refresh(BACKGROUND_CONTEXT)]);
		expect(state.value.view).toMatchObject({ kind: "listing", path: "nested", page: { offset: 0, total: 0 } });
	});

	it("rejects invalid offsets without changing the view and clamps huge valid offsets", async () => {
		const { runtime, state } = await setup(1);
		await runtime.service.open(".", BACKGROUND_CONTEXT);
		const revision = state.value.revision;
		for (const offset of [-1, 0.5, NaN, Infinity]) await expect(runtime.service.open({ path: ".", offset }, BACKGROUND_CONTEXT)).rejects.toThrow("Invalid workspace directory page");
		await expect(runtime.service.open(null as unknown as WorkspaceOpenInput, BACKGROUND_CONTEXT)).rejects.toThrow();
		expect(state.value.revision).toBe(revision);
		await runtime.service.open({ path: ".", offset: Number.MAX_SAFE_INTEGER }, BACKGROUND_CONTEXT);
		expect(state.value.view).toMatchObject({ kind: "listing", page: { offset: 0, total: 1 } });
	});

	it("keeps traversal and symlink authorization, without reading escaped target metadata", async () => {
		const { cwd, runtime, state } = await setup(1);
		const outside = await directory();
		await writeFile(join(outside, "secret.txt"), "private");
		await symlink(join(outside, "secret.txt"), join(cwd, "escape"));
		await mkdir(join(cwd, "inner"));
		await symlink(join(cwd, "inner"), join(cwd, "alias"));
		vi.mocked(stat).mockClear();
		await runtime.service.open(".", BACKGROUND_CONTEXT);
		expect(vi.mocked(stat).mock.calls.some(([path]) => String(path) === join(cwd, "escape"))).toBe(false);
		await runtime.service.read("escape", BACKGROUND_CONTEXT);
		expect(state.value.view).toMatchObject({ kind: "denied" });
		await runtime.service.open({ path: outside, offset: 100 }, BACKGROUND_CONTEXT);
		expect(state.value.view).toMatchObject({ kind: "denied" });
		await runtime.service.open("alias", BACKGROUND_CONTEXT);
		expect(state.value.view).toMatchObject({ kind: "listing", path: "inner" });
	});

	it("keeps the displayed workspace selected when a directory switch is cancelled", async () => {
		const { cwd } = await setup(1);
		const other = await directory();
		await writeFile(join(other, "file-0000.txt"), "other-workspace");
		const controller = new AbortController();
		let cancel = false;
		const runtime = createWorkspaceService({ cwd, directories: async () => {
			if (cancel) controller.abort(new Error("cancelled"));
			return [cwd, other];
		} }, initial => replicatedState(initial));
		await runtime.service.open(".", BACKGROUND_CONTEXT);
		const revision = runtime.service.state.value.revision;
		cancel = true;
		await expect(runtime.service.open({ path: other, offset: 0 }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))).rejects.toThrow("cancelled");
		expect(runtime.service.state.value.revision).toBe(revision);
		cancel = false;
		await runtime.service.read("file-0000.txt", BACKGROUND_CONTEXT);
		expect(runtime.service.state.value.view).toMatchObject({ kind: "text", text: "body-0" });
	});

	it("honors cancellation without publishing a page", async () => {
		const { runtime, state } = await setup(1);
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(runtime.service.open(".", withAbortSignal(controller.signal, BACKGROUND_CONTEXT))).rejects.toThrow("cancelled");
		expect(state.value.revision).toBe(0);
	});
});
