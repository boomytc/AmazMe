import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@amazme/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrThrow } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";

const hooks = vi.hoisted(() => ({
	beforeSync: undefined as (() => Promise<void>) | undefined,
	failPublishedStat: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fs,
		open: async (...args: Parameters<typeof fs.open>) => {
			const file = await fs.open(...args);
			if (String(args[0]).endsWith(".staging/content")) {
				if (hooks.failPublishedStat) vi.spyOn(file, "stat").mockRejectedValue(new Error("revision unavailable"));
				const sync = file.sync.bind(file);
				file.sync = async () => {
					await sync();
					await hooks.beforeSync?.();
				};
			}
			return file;
		},
	};
});

const context = BACKGROUND_CONTEXT;
const dirs: string[] = [];
afterEach(() => {
	hooks.beforeSync = undefined;
	hooks.failPublishedStat = false;
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function environment(): NodeExecutionEnv {
	const cwd = mkdtempSync(join(tmpdir(), "amazme-checked-write-"));
	dirs.push(cwd);
	return new NodeExecutionEnv({ cwd });
}

describe("Node checked publication", () => {
	it("reports completed publication without a replacement basis when revision sampling fails", async () => {
		const env = environment();
		hooks.failPublishedStat = true;
		const result = getOrThrow(await env.writeFileChecked("file.txt", "published", { kind: "createIfAbsent" }, context));
		expect(result.operation).toBe("create");
		expect(result.version).toBeUndefined();
		expect(readFileSync(join(env.cwd, "file.txt"), "utf8")).toBe("published");
		expect(readdirSync(env.cwd)).toEqual(["file.txt"]);
		expect(await env.writeFileChecked("file.txt", "blind", { kind: "createIfAbsent" }, context)).toMatchObject({
			ok: false,
			error: { code: "not_observed" },
		});
	});

	it("rejects external same-length changes even when mtime is restored", async () => {
		const env = environment();
		const path = join(env.cwd, "file.txt");
		writeFileSync(path, "one");
		const before = statSync(path);
		const observed = getOrThrow(await env.fileRevision(path, context));
		writeFileSync(path, "two");
		utimesSync(path, before.atime, before.mtime);
		expect(
			await env.writeFileChecked(path, "lost", { kind: "replaceIfVersion", revision: observed }, context),
		).toMatchObject({ ok: false, error: { code: "stale_version" } });
		expect(readFileSync(path, "utf8")).toBe("two");
	});

	it("rechecks after staging and preserves an external replacement", async () => {
		const env = environment();
		writeFileSync(join(env.cwd, "file.txt"), "before");
		const observed = getOrThrow(await env.fileRevision("file.txt", context));
		hooks.beforeSync = async () => {
			writeFileSync(join(env.cwd, "file.txt"), "external");
		};
		expect(
			await env.writeFileChecked("file.txt", "lost", { kind: "replaceIfVersion", revision: observed }, context),
		).toMatchObject({ ok: false, error: { code: "stale_version" } });
		expect(readFileSync(join(env.cwd, "file.txt"), "utf8")).toBe("external");
		expect(readdirSync(env.cwd)).toEqual(["file.txt"]);
	});

	it("refuses an external create made while the new bytes were staged", async () => {
		const env = environment();
		hooks.beforeSync = async () => {
			writeFileSync(join(env.cwd, "file.txt"), "external");
		};
		expect(await env.writeFileChecked("file.txt", "lost", { kind: "createIfAbsent" }, context)).toMatchObject({
			ok: false,
			error: { code: "not_observed" },
		});
		expect(readFileSync(join(env.cwd, "file.txt"), "utf8")).toBe("external");
		expect(readdirSync(env.cwd)).toEqual(["file.txt"]);
	});

	it("discards staged bytes when cancellation arrives before publication", async () => {
		const env = environment();
		writeFileSync(join(env.cwd, "file.txt"), "before");
		const observed = getOrThrow(await env.fileRevision("file.txt", context));
		const controller = new AbortController();
		hooks.beforeSync = async () => {
			controller.abort();
		};
		expect(
			await env.writeFileChecked(
				"file.txt",
				"lost",
				{ kind: "replaceIfVersion", revision: observed },
				withAbortSignal(controller.signal, context),
			),
		).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(readFileSync(join(env.cwd, "file.txt"), "utf8")).toBe("before");
		expect(readdirSync(env.cwd)).toEqual(["file.txt"]);
	});

	it("keeps the preceding writer's barrier when a queued waiter is cancelled", async () => {
		const env = environment();
		const sibling = new NodeExecutionEnv({ cwd: env.cwd });
		writeFileSync(join(env.cwd, "file.txt"), "before");
		const observed = getOrThrow(await env.fileRevision("file.txt", context));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		hooks.beforeSync = async () => {
			entered.resolve();
			await release.promise;
		};
		const intent = { kind: "replaceIfVersion" as const, revision: observed };
		const first = env.writeFileChecked("file.txt", "first", intent, context);
		await entered.promise;
		const controller = new AbortController();
		const cancelled = sibling.writeFileChecked(
			"file.txt",
			"cancelled",
			intent,
			withAbortSignal(controller.signal, context),
		);
		controller.abort();
		expect(await cancelled).toMatchObject({ ok: false, error: { code: "aborted" } });
		const last = sibling.writeFileChecked("file.txt", "last", intent, context);
		release.resolve();
		expect(getOrThrow(await first).operation).toBe("replace");
		expect(await last).toMatchObject({ ok: false, error: { code: "stale_version" } });
		expect(readFileSync(join(env.cwd, "file.txt"), "utf8")).toBe("first");
	});

	it.skipIf(process.platform === "win32")("refuses a retargeted directory alias before publishing", async () => {
		const env = environment();
		getOrThrow(await env.createDir("one", undefined, context));
		getOrThrow(await env.createDir("two", undefined, context));
		writeFileSync(join(env.cwd, "one", "file.txt"), "before");
		writeFileSync(join(env.cwd, "two", "file.txt"), "other");
		symlinkSync("one", join(env.cwd, "alias"));
		const observed = getOrThrow(await env.fileRevision("alias/file.txt", context));
		hooks.beforeSync = async () => {
			unlinkSync(join(env.cwd, "alias"));
			symlinkSync("two", join(env.cwd, "alias"));
		};
		expect(
			await env.writeFileChecked(
				"alias/file.txt",
				"lost",
				{ kind: "replaceIfVersion", revision: observed },
				context,
			),
		).toMatchObject({ ok: false, error: { code: "stale_version" } });
		expect(readFileSync(join(env.cwd, "one", "file.txt"), "utf8")).toBe("before");
		expect(readFileSync(join(env.cwd, "two", "file.txt"), "utf8")).toBe("other");
		expect(readdirSync(join(env.cwd, "one"))).toEqual(["file.txt"]);
	});

	it.skipIf(process.platform === "win32")("preserves executable permission bits across replacement", async () => {
		const env = environment();
		const path = join(env.cwd, "script.sh");
		writeFileSync(path, "before");
		chmodSync(path, 0o751);
		const observed = getOrThrow(await env.fileRevision(path, context));
		getOrThrow(
			await env.writeFileChecked(path, "after", { kind: "replaceIfVersion", revision: observed }, context),
		);
		expect(statSync(path).mode & 0o777).toBe(0o751);
	});

	it.skipIf(process.platform === "win32")(
		"rejects FIFO revisions without blocking for a writer",
		async () => {
			const env = environment();
			execFileSync("mkfifo", [join(env.cwd, "pipe")]);
			expect(await env.fileRevision("pipe", context)).toMatchObject({ ok: false, error: { code: "invalid" } });
		},
		1000,
	);
});
