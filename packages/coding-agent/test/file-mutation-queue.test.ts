import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { NodeExecutionEnv } from "@amazme/durable/env/node";
import { withFileMutationQueue } from "@amazme/durable/file-operations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAllTools } from "../src/core/tools/index.ts";

const env = new NodeExecutionEnv({ cwd: process.cwd() });
const queued = <T>(path: string, fn: () => Promise<T>) => withFileMutationQueue(env, path, fn, BACKGROUND_CONTEXT);

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function resolvesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	return Promise.race([promise.then(() => true), delay(ms).then(() => false)]);
}

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-file-mutation-queue-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("withFileMutationQueue", () => {
	it("serializes operations for the same file", async () => {
		const order: string[] = [];
		const path = "/tmp/file-mutation-queue-same";
		let active = 0;
		let maxActive = 0;

		const first = queued(path, async () => {
			maxActive = Math.max(maxActive, ++active);
			order.push("first:start");
			await delay(30);
			order.push("first:end");
			active--;
		});
		const second = queued(path, async () => {
			maxActive = Math.max(maxActive, ++active);
			order.push("second:start");
			await delay(30);
			order.push("second:end");
			active--;
		});

		await Promise.all([first, second]);
		// Canonical path resolution can finish in either order; execution must never overlap.
		expect(maxActive).toBe(1);
		expect(order).toHaveLength(4);
		expect(order[1]).toBe(order[0]?.replace(":start", ":end"));
		expect(order[3]).toBe(order[2]?.replace(":start", ":end"));
	});

	it("allows different files to proceed in parallel", async () => {
		const order: string[] = [];

		await Promise.all([
			queued("/tmp/file-mutation-queue-a", async () => {
				order.push("a:start");
				await delay(30);
				order.push("a:end");
			}),
			queued("/tmp/file-mutation-queue-b", async () => {
				order.push("b:start");
				await delay(30);
				order.push("b:end");
			}),
		]);

		expect(order.indexOf("a:start")).toBeLessThan(order.indexOf("a:end"));
		expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("b:end"));
		expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("a:end"));
	});

	it("uses the same queue for symlink aliases", async () => {
		const dir = await createTempDir();
		const targetPath = join(dir, "target.txt");
		const symlinkPath = join(dir, "alias.txt");
		await writeFile(targetPath, "hello\n", "utf8");
		await symlink(targetPath, symlinkPath);

		const order: string[] = [];
		await Promise.all([
			queued(targetPath, async () => {
				order.push("target:start");
				await delay(30);
				order.push("target:end");
			}),
			queued(symlinkPath, async () => {
				order.push("alias:start");
				await delay(30);
				order.push("alias:end");
			}),
		]);

		expect(order).toHaveLength(4);
		expect(order[1]).toBe(order[0]?.replace(":start", ":end"));
		expect(order[3]).toBe(order[2]?.replace(":start", ":end"));
	});
});

describe("built-in edit and write tools", () => {
	it("preserves both parallel edits after one read", async () => {
		const dir = await createTempDir();
		const tools = createAllTools(dir);
		await writeFile(join(dir, "file.txt"), "alpha\nbeta\ngamma\n");
		await tools.read.execute("read", { path: "file.txt" });
		await Promise.all([
			tools.edit.execute("first", {
				path: "file.txt",
				edits: [{ oldText: "alpha", newText: "ALPHA" }],
			}),
			tools.edit.execute("second", {
				path: "file.txt",
				edits: [{ oldText: "beta", newText: "BETA" }],
			}),
		]);
		expect(await readFile(join(dir, "file.txt"), "utf8")).toBe("ALPHA\nBETA\ngamma\n");
	});

	it("shares the queue and refreshed observation between edit and write", async () => {
		const dir = await createTempDir();
		const files = new NodeExecutionEnv({ cwd: dir });
		const tools = createAllTools(dir, { fileSystem: files });
		await writeFile(join(dir, "file.txt"), "original\n");
		await tools.read.execute("read", { path: "file.txt" });
		const started = createDeferred();
		const revision = files.fileRevision.bind(files);
		vi.spyOn(files, "fileRevision").mockImplementation(async (...args) => {
			const result = await revision(...args);
			started.resolve();
			return result;
		});
		const edited = tools.edit.execute("edit", {
			path: "file.txt",
			edits: [{ oldText: "original", newText: "edited" }],
		});
		await started.promise;
		const written = tools.write.execute("write", {
			path: "file.txt",
			content: "replacement\n",
		});
		await Promise.all([edited, written]);
		expect(await readFile(join(dir, "file.txt"), "utf8")).toBe("replacement\n");
	});

	for (const kind of ["write", "edit"] as const) {
		it(`keeps the ${kind} barrier until cancelled IO actually publishes, then reports completion`, async () => {
			const dir = await createTempDir();
			const files = new NodeExecutionEnv({ cwd: dir });
			const tools = createAllTools(dir, { fileSystem: files });
			await writeFile(join(dir, "file.txt"), "alpha\nbeta\n");
			await tools.read.execute("read", { path: "file.txt" });
			const started = createDeferred();
			const finish = createDeferred();
			const secondStarted = createDeferred();
			const publish = files.writeFileChecked.bind(files);
			let calls = 0;
			vi.spyOn(files, "writeFileChecked").mockImplementation(async (path, content, intent, context) => {
				if (++calls === 1) {
					started.resolve();
					await finish.promise;
					return publish(path, content, intent, BACKGROUND_CONTEXT);
				}
				secondStarted.resolve();
				return publish(path, content, intent, context);
			});
			const controller = new AbortController();
			const first =
				kind === "write"
					? tools.write.execute("first", { path: "file.txt", content: "ALPHA\nbeta\n" }, controller.signal)
					: tools.edit.execute(
							"first",
							{
								path: "file.txt",
								edits: [{ oldText: "alpha", newText: "ALPHA" }],
							},
							controller.signal,
						);
			await started.promise;
			controller.abort();
			const second = tools.edit.execute("second", {
				path: "file.txt",
				edits: [{ oldText: "beta", newText: "BETA" }],
			});
			expect(await resolvesWithin(secondStarted.promise, 20)).toBe(false);
			finish.resolve();
			expect((await first).content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("Successfully"),
			});
			await second;
			expect(await readFile(join(dir, "file.txt"), "utf8")).toBe("ALPHA\nBETA\n");
		});
	}
});
