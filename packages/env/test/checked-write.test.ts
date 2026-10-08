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
import { getOrThrow } from "@amazme/durable/env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import { daemon } from "./daemon.ts";

const context = BACKGROUND_CONTEXT;
const connections: Connection[] = [];
const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const connection of connections.splice(0)) connection.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

function environment(): { env: RemoteExecutionEnv; connection: Connection } {
	const cwd = mkdtempSync(join(tmpdir(), "amazme-remote-checked-write-"));
	dirs.push(cwd);
	const connection = new Connection({ command: [daemon] });
	connections.push(connection);
	return { env: new RemoteExecutionEnv({ connection, id: "amazme-env:test", cwd }), connection };
}

describe("Remote checked publication through the actual daemon", () => {
	it("discards a staged multi-chunk transfer cancelled before publication", async () => {
		const { env, connection } = environment();
		writeFileSync(join(env.cwd, "file.txt"), "before");
		const observed = getOrThrow(await env.fileRevision("file.txt", context));
		const controller = new AbortController();
		const request = connection.request.bind(connection);
		vi.spyOn(connection, "request").mockImplementation(async (op, json, options) => {
			const reply = await request(op, json, options);
			if (op === "writeChunk") controller.abort();
			return reply;
		});
		expect(
			await env.writeFileChecked(
				"file.txt",
				new Uint8Array(1_500_000),
				{ kind: "replaceIfVersion", version: observed.version },
				withAbortSignal(controller.signal, context),
			),
		).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(readFileSync(join(env.cwd, "file.txt"), "utf8")).toBe("before");
		expect(readdirSync(env.cwd)).toEqual(["file.txt"]);
	});

	it("refuses an external change made after staging began", async () => {
		const { env, connection } = environment();
		writeFileSync(join(env.cwd, "file.txt"), "before");
		const observed = getOrThrow(await env.fileRevision("file.txt", context));
		const request = connection.request.bind(connection);
		vi.spyOn(connection, "request").mockImplementation(async (op, json, options) => {
			const reply = await request(op, json, options);
			if (op === "checkedWriteOpen") writeFileSync(join(env.cwd, "file.txt"), "external");
			return reply;
		});
		expect(
			await env.writeFileChecked("file.txt", "lost", { kind: "replaceIfVersion", version: observed.version }, context),
		).toMatchObject({ ok: false, error: { code: "stale_version" } });
		expect(readFileSync(join(env.cwd, "file.txt"), "utf8")).toBe("external");
		expect(readdirSync(env.cwd)).toEqual(["file.txt"]);
	});

	it("does not report an already published write as cancelled", async () => {
		const { env, connection } = environment();
		const controller = new AbortController();
		const request = connection.request.bind(connection);
		vi.spyOn(connection, "request").mockImplementation(async (op, json, options) => {
			const reply = await request(op, json, options);
			if (op === "checkedPublish") controller.abort();
			return reply;
		});
		const result = getOrThrow(
			await env.writeFileChecked(
				"file.txt",
				"published",
				{ kind: "createIfAbsent" },
				withAbortSignal(controller.signal, context),
			),
		);
		expect(result.operation).toBe("create");
		expect(readFileSync(join(env.cwd, "file.txt"), "utf8")).toBe("published");
		expect(getOrThrow(await env.fileRevision("file.txt", context))).toEqual({
			path: result.path,
			version: result.version,
		});
	});

	it("cleans an abandoned staging handle on close", async () => {
		const { env, connection } = environment();
		const reply = await connection.request(
			"checkedWriteOpen",
			{ path: join(env.cwd, "file.txt"), intent: { kind: "createIfAbsent" } },
			{ payload: new TextEncoder().encode("staged") },
		);
		expect(readdirSync(env.cwd).some((name) => name.startsWith(".amazme-write-"))).toBe(true);
		await connection.request("close", { handle: reply.json.handle }, { session: reply.session });
		expect(readdirSync(env.cwd)).toEqual([]);
	});

	it("cleans uncommitted handles when the connection shuts down", async () => {
		const { env, connection } = environment();
		await connection.request(
			"checkedWriteOpen",
			{ path: join(env.cwd, "file.txt"), intent: { kind: "createIfAbsent" } },
			{ payload: new TextEncoder().encode("staged") },
		);
		connection.close();
		await vi.waitFor(() => expect(readdirSync(env.cwd)).toEqual([]), { timeout: 3000 });
	});

	it("detects same-size changes with restored mtime using change metadata", async () => {
		const { env } = environment();
		const path = join(env.cwd, "file.txt");
		writeFileSync(path, "one");
		const before = statSync(path);
		const observed = getOrThrow(await env.fileRevision(path, context));
		writeFileSync(path, "two");
		utimesSync(path, before.atime, before.mtime);
		expect(
			await env.writeFileChecked(path, "lost", { kind: "replaceIfVersion", version: observed.version }, context),
		).toMatchObject({ ok: false, error: { code: "stale_version" } });
		expect(readFileSync(path, "utf8")).toBe("two");
	});

	it.skipIf(process.platform === "win32")("refuses a retargeted alias after its bytes were staged", async () => {
		const { env, connection } = environment();
		getOrThrow(await env.createDir("one", undefined, context));
		getOrThrow(await env.createDir("two", undefined, context));
		writeFileSync(join(env.cwd, "one", "file.txt"), "before");
		writeFileSync(join(env.cwd, "two", "file.txt"), "other");
		symlinkSync("one", join(env.cwd, "alias"));
		const observed = getOrThrow(await env.fileRevision("alias/file.txt", context));
		const request = connection.request.bind(connection);
		vi.spyOn(connection, "request").mockImplementation(async (op, json, options) => {
			const reply = await request(op, json, options);
			if (op === "checkedWriteOpen") {
				unlinkSync(join(env.cwd, "alias"));
				symlinkSync("two", join(env.cwd, "alias"));
			}
			return reply;
		});
		expect(
			await env.writeFileChecked(
				"alias/file.txt",
				"lost",
				{ kind: "replaceIfVersion", version: observed.version },
				context,
			),
		).toMatchObject({ ok: false, error: { code: "stale_version" } });
		expect(readFileSync(join(env.cwd, "one", "file.txt"), "utf8")).toBe("before");
		expect(readFileSync(join(env.cwd, "two", "file.txt"), "utf8")).toBe("other");
		expect(readdirSync(join(env.cwd, "one"))).toEqual(["file.txt"]);
	});

	it.skipIf(process.platform === "win32")("preserves executable mode bits", async () => {
		const { env } = environment();
		const path = join(env.cwd, "script.sh");
		writeFileSync(path, "before");
		chmodSync(path, 0o751);
		const observed = getOrThrow(await env.fileRevision(path, context));
		getOrThrow(
			await env.writeFileChecked(path, "after", { kind: "replaceIfVersion", version: observed.version }, context),
		);
		expect(statSync(path).mode & 0o777).toBe(0o751);
	});
});
