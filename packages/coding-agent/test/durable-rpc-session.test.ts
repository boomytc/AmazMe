import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenDurableResult } from "../src/durable/runtime.ts";
import { createDurableRpcSessionControl } from "../src/modes/rpc/durable-rpc.ts";
import { createTempDir } from "./temp-dir.ts";

function session(directory: string | undefined): OpenDurableResult {
	return {
		view: {
			current: () => ({
				session: { id: directory === undefined ? "memory" : "session", ...(directory === undefined ? {} : { directory }), cwd: "/project" },
			}),
		},
	} as unknown as OpenDurableResult;
}

describe("durable RPC session control", () => {
	let directory: string;
	let cwd: string;

	beforeEach(async () => {
		directory = createTempDir("amazme-durable-rpc-session-");
		cwd = join(directory, "project");
		await mkdir(cwd);
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("opens a fresh session and rejects parentSession", async () => {
		const current = session(join(directory, "current"));
		const next = session(join(directory, "next"));
		const replace = vi.fn(async () => {});
		const open = vi.fn(async () => next);
		const control = createDurableRpcSessionControl({ options: { cwd }, current: () => current, open, replace });

		expect(await control.newSession()).toEqual({ cancelled: false });
		expect(open).toHaveBeenCalledWith(expect.objectContaining({ continueSession: false, sessionDirectory: undefined }));
		expect(replace).toHaveBeenCalledWith(next);
		await expect(control.newSession("parent.jsonl")).rejects.toThrow("parentSession");
	});

	it("switches to a directory, a database, or an imported JSONL session", async () => {
		const currentDirectory = join(directory, "current");
		await mkdir(currentDirectory);
		const current = session(await realpath(currentDirectory));
		const next = session(join(directory, "next"));
		const replace = vi.fn(async () => {});
		const open = vi.fn(async () => next);
		const importFile = vi.fn(async () => ({ directory: join(directory, "imported"), cwd: "/imported" }));
		const control = createDurableRpcSessionControl({ options: { cwd }, current: () => current, open, replace, importFile });

		const target = join(directory, "target");
		await mkdir(target);
		await writeFile(join(target, "session.sqlite"), "");
		expect(await control.switchSession(target)).toEqual({ cancelled: false });
		expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ sessionDirectory: await realpath(target) }));

		expect(await control.switchSession(join(target, "session.sqlite"))).toEqual({ cancelled: false });
		expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ sessionDirectory: await realpath(target) }));

		const file = join(directory, "session.jsonl");
		await writeFile(file, "{}\n");
		expect(await control.switchSession(file)).toEqual({ cancelled: false });
		expect(importFile).toHaveBeenCalledWith(file, expect.any(Object));
		expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: "/imported", sessionDirectory: join(directory, "imported") }));

		expect(await control.switchSession(currentDirectory)).toEqual({ cancelled: false });
		expect(open).toHaveBeenCalledTimes(3);
	});

	it("switches from a memory session to a persistent one and rejects a missing path", async () => {
		const target = join(directory, "target");
		await mkdir(target);
		await writeFile(join(target, "session.sqlite"), "");
		const open = vi.fn(async () => session(target));
		const control = createDurableRpcSessionControl({
			options: { cwd, noSession: true },
			current: () => session(undefined),
			open,
			replace: async () => {},
		});
		expect(await control.switchSession(target)).toEqual({ cancelled: false });
		expect(open).toHaveBeenCalledWith(expect.objectContaining({ noSession: false, sessionDirectory: await realpath(target) }));
		const persistent = createDurableRpcSessionControl({
			options: { cwd },
			current: () => session(join(directory, "current")),
			open: async () => session(undefined),
			replace: async () => {},
		});
		await expect(persistent.switchSession(join(directory, "missing"))).rejects.toThrow("Session not found");
	});
});
