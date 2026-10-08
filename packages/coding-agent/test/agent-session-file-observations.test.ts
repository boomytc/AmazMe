import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@amazme/ai/compat";
import { type FileSystem, getOrThrow, ok } from "@amazme/durable/env";
import { NodeExecutionEnv } from "@amazme/durable/env/node";
import { Connection, RemoteExecutionEnv } from "@amazme/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineTool } from "../src/core/extensions/types.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createMemoryFileObservations, sessionFileObservations } from "../src/core/file-observations.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createAllTools } from "../src/core/tools/index.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import type { FileToolOptions } from "../src/core/tools/file-runtime.ts";

let cwd: string;
const sessions: AgentSession[] = [];
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "amazme-sdk-file-observations-"));
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) session.dispose();
	rmSync(cwd, { recursive: true, force: true });
});

function manager() {
	const value = SessionManager.create(cwd, join(cwd, "sessions"));
	value.appendMessage({
		role: "user",
		content: "fixture",
		timestamp: Date.now(),
	});
	return value;
}

async function sessionFor(sessionManager = manager(), files?: FileSystem) {
	const agentDir = join(cwd, "agent");
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const result = await createAgentSession({
		cwd,
		agentDir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		settingsManager,
		resourceLoader,
		sessionManager,
		customTools: files
			? [
					defineTool(createReadToolDefinition(cwd, { fileSystem: files })),
					defineTool(createWriteToolDefinition(cwd, { fileSystem: files })),
				]
			: undefined,
	});
	sessions.push(result.session);
	return result.session;
}

function tool(session: AgentSession, name: string) {
	const value = session.agent.state.tools.find((entry) => entry.name === name);
	if (!value) throw new Error(`Missing fixture tool: ${name}`);
	return value;
}

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("AgentSession file observations", () => {
	it("denies blind replacement and blind edit, then refreshes the basis after each mutation", async () => {
		writeFileSync(join(cwd, "file.txt"), "original");
		const session = await sessionFor();
		await expect(
			tool(session, "write").execute("blind", {
				path: "file.txt",
				content: "lost",
			}),
		).rejects.toMatchObject({ code: "not_observed" });
		await expect(
			tool(session, "edit").execute("blind-edit", {
				path: "file.txt",
				edits: [{ oldText: "original", newText: "lost" }],
			}),
		).rejects.toMatchObject({ code: "not_observed" });
		await tool(session, "read").execute("read", { path: "file.txt" });
		const edited = await tool(session, "edit").execute("edit", {
			path: "file.txt",
			edits: [{ oldText: "original", newText: "edited" }],
		});
		expect(edited.details).toMatchObject({
			patch: expect.stringContaining("+edited"),
		});
		await tool(session, "write").execute("replace", {
			path: "file.txt",
			content: "replacement",
		});
		expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("replacement");
		expect(session.sessionManager.buildSessionContext().messages).toHaveLength(1);
	});

	it("rejects outside modification before old-text matching and preserves outside bytes", async () => {
		writeFileSync(join(cwd, "file.txt"), "original");
		const session = await sessionFor();
		await tool(session, "read").execute("read", { path: "file.txt" });
		writeFileSync(join(cwd, "file.txt"), "external");
		await expect(
			tool(session, "edit").execute("edit", {
				path: "file.txt",
				edits: [{ oldText: "not present", newText: "lost" }],
			}),
		).rejects.toMatchObject({ code: "stale_version" });
		await expect(
			tool(session, "write").execute("replace", {
				path: "file.txt",
				content: "lost",
			}),
		).rejects.toMatchObject({ code: "stale_version" });
		expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("external");
	});

	it("preserves a concurrent creation after a read established absence", async () => {
		const session = await sessionFor();
		await expect(tool(session, "read").execute("missing", { path: "new.txt" })).rejects.toMatchObject({
			code: "not_found",
		});
		writeFileSync(join(cwd, "new.txt"), "created outside");
		await expect(
			tool(session, "write").execute("write", {
				path: "new.txt",
				content: "lost",
			}),
		).rejects.toMatchObject({ code: "not_observed" });
		expect(readFileSync(join(cwd, "new.txt"), "utf8")).toBe("created outside");
	});

	it("restores the actual JSONL observation after dispose, open and a fresh SDK runtime", async () => {
		writeFileSync(join(cwd, "file.txt"), "original");
		const original = await sessionFor();
		await tool(original, "read").execute("read", { path: "file.txt" });
		const file = original.sessionFile!;
		original.dispose();
		const restored = await sessionFor(SessionManager.open(file));
		await tool(restored, "edit").execute("restored-edit", {
			path: "file.txt",
			edits: [{ oldText: "original", newText: "restored" }],
		});
		expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("restored");
	});

	it("retains observations across resource reload but isolates another session in the same cwd", async () => {
		writeFileSync(join(cwd, "file.txt"), "original");
		const session = await sessionFor();
		await tool(session, "read").execute("read", { path: "file.txt" });
		await session.reload();
		await tool(session, "write").execute("after-reload", {
			path: "file.txt",
			content: "reloaded",
		});
		const other = await sessionFor();
		await expect(
			tool(other, "write").execute("other", {
				path: "file.txt",
				content: "lost",
			}),
		).rejects.toMatchObject({ code: "not_observed" });
	});

	it("starts a fork with no observations even when the copied branch includes the old journal records", async () => {
		writeFileSync(join(cwd, "file.txt"), "original");
		const owner = manager();
		const original = await sessionFor(owner);
		await tool(original, "read").execute("read", { path: "file.txt" });
		const oldFile = owner.getSessionFile()!;
		owner.createBranchedSession(owner.getLeafId()!);
		const fork = await sessionFor(SessionManager.open(owner.getSessionFile()!));
		await expect(
			tool(fork, "write").execute("fork-write", {
				path: "file.txt",
				content: "lost",
			}),
		).rejects.toMatchObject({ code: "not_observed" });
		const resumedOriginal = await sessionFor(SessionManager.open(oldFile));
		await tool(resumedOriginal, "write").execute("original-write", {
			path: "file.txt",
			content: "original still owns its observation",
		});
	});

	it("resets a navigated branch and only restores its new observations after restart", async () => {
		writeFileSync(join(cwd, "one.txt"), "one");
		writeFileSync(join(cwd, "two.txt"), "two");
		const owner = manager();
		const branchPoint = owner.getLeafId()!;
		const session = await sessionFor(owner);
		await tool(session, "read").execute("one", { path: "one.txt" });
		await tool(session, "read").execute("two", { path: "two.txt" });
		owner.branch(branchPoint);
		await expect(
			tool(session, "write").execute("blind-branch", {
				path: "one.txt",
				content: "lost",
			}),
		).rejects.toMatchObject({ code: "not_observed" });
		await tool(session, "read").execute("branch-read", { path: "one.txt" });
		const reopened = await sessionFor(SessionManager.open(owner.getSessionFile()!));
		await expect(
			tool(reopened, "write").execute("other-file", {
				path: "two.txt",
				content: "lost",
			}),
		).rejects.toMatchObject({ code: "not_observed" });
		await tool(reopened, "write").execute("branch-write", {
			path: "one.txt",
			content: "branch",
		});
	});

	it("does not borrow the observation when a directory alias is retargeted", async () => {
		writeFileSync(join(cwd, "one.txt"), "one");
		writeFileSync(join(cwd, "two.txt"), "two");
		symlinkSync("one.txt", join(cwd, "alias.txt"));
		const session = await sessionFor();
		await tool(session, "read").execute("read-alias", { path: "alias.txt" });
		unlinkSync(join(cwd, "alias.txt"));
		symlinkSync("two.txt", join(cwd, "alias.txt"));
		await expect(
			tool(session, "write").execute("retarget", {
				path: "alias.txt",
				content: "lost",
			}),
		).rejects.toMatchObject({ code: "not_observed" });
		expect(readFileSync(join(cwd, "one.txt"), "utf8")).toBe("one");
		expect(readFileSync(join(cwd, "two.txt"), "utf8")).toBe("two");
	});

	it("reports a completed publication when journal persistence fails, then denies the stale basis", async () => {
		writeFileSync(join(cwd, "file.txt"), "original");
		const owner = manager();
		const session = await sessionFor(owner);
		await tool(session, "read").execute("read", { path: "file.txt" });
		vi.spyOn(owner, "appendCustomEntry").mockImplementationOnce(() => {
			throw new Error("journal unavailable");
		});
		const result = await tool(session, "write").execute("published", {
			path: "file.txt",
			content: "published",
		});
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining("File write completed"),
		});
		expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("published");
		await expect(
			tool(session, "write").execute("stale", {
				path: "file.txt",
				content: "lost",
			}),
		).rejects.toMatchObject({ code: "stale_version" });
	});

	it("awaits cancelled reader cleanup and cannot append its late observation to a new session", async () => {
		writeFileSync(join(cwd, "file.txt"), "original");
		const files = new NodeExecutionEnv({ cwd });
		const opened = files.openBinaryReader.bind(files);
		const started = deferred();
		const finish = deferred();
		let closed = false;
		vi.spyOn(files, "openBinaryReader").mockImplementation(async (path, options, context) => {
			const reader = getOrThrow(await opened(path, options, context));
			return ok({
				revision: (ctx) => reader.revision(ctx),
				info: (ctx) => reader.info(ctx),
				scanLines: (args, ctx) => reader.scanLines(args, ctx),
				read: async (offset, length, ctx) => {
					started.resolve();
					await finish.promise;
					return reader.read(offset, length, ctx);
				},
				close: async (ctx) => {
					await reader.close(ctx);
					closed = true;
				},
			});
		});
		const owner = manager();
		const session = await sessionFor(owner, files);
		const controller = new AbortController();
		let settled = false;
		const pending = tool(session, "read")
			.execute("cancelled", { path: "file.txt" }, controller.signal)
			.then(
				() => {
					settled = true;
				},
				(error: unknown) => {
					settled = true;
					return error;
				},
			);
		await started.promise;
		controller.abort();
		owner.newSession();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(settled).toBe(false);
		expect(closed).toBe(false);
		finish.resolve();
		expect(await pending).toBeInstanceOf(Error);
		expect(closed).toBe(true);
		expect(owner.getEntries()).toEqual([]);
	});
});

describe("standalone observation ownership", () => {
	it("rejects unsupported backend options before a JavaScript caller can accidentally create a local file", () => {
		const options: unknown = { operations: { writeFile: () => { throw new Error("remote backend"); } } };
		expect(() => createWriteToolDefinition(cwd, options as FileToolOptions)).toThrow("Unsupported file tool option: operations");
		expect(existsSync(join(cwd, "new.txt"))).toBe(false);
	});

	it("shares only the selected tool group's observations", async () => {
		writeFileSync(join(cwd, "file.txt"), "original");
		const first = createAllTools(cwd);
		const other = createAllTools(cwd);
		await first.read.execute("read", { path: "file.txt" });
		await expect(other.write.execute("other", { path: "file.txt", content: "lost" })).rejects.toMatchObject({
			code: "not_observed",
		});
		await first.write.execute("write", { path: "file.txt", content: "first" });
	});

	it("bounds replayed observations and does not share namespaces", async () => {
		const owner = manager();
		const scope = sessionFileObservations(owner).capture();
		for (let i = 0; i < 1025; i++)
			await scope.record("files", `/file-${i}`, {
				kind: "present",
				version: `v${i}`,
			});
		const restored = sessionFileObservations(SessionManager.open(owner.getSessionFile()!)).capture();
		expect(restored.get("files", "/file-0")).toBeUndefined();
		expect(restored.get("files", "/file-1024")).toEqual({
			kind: "present",
			version: "v1024",
		});
		expect(restored.get("other-files", "/file-1024")).toBeUndefined();
	});

	it("retires a captured owner before its first asynchronous side effect", async () => {
		const owner = manager();
		const scope = sessionFileObservations(owner).capture();
		owner.newSession();
		await expect(scope.record("files", "/file", { kind: "absent" })).rejects.toThrow("scope changed");
		expect(owner.getEntries()).toEqual([]);
	});

	it("returns copies to callers and does not use cwd as a shared cache", async () => {
		const store = createMemoryFileObservations();
		const scope = store.capture();
		await scope.record("files", "/file", { kind: "present", version: "v1" });
		const snapshot = scope.get("files", "/file")!;
		if (snapshot.kind === "present") snapshot.version = "changed";
		expect(scope.get("files", "/file")).toEqual({
			kind: "present",
			version: "v1",
		});
		expect(createMemoryFileObservations().capture().get("files", "/file")).toBeUndefined();
	});
});

it.skipIf(
	!existsSync(
		join(
			import.meta.dirname,
			"../../env/daemon/target/debug",
			process.platform === "win32" ? "amazme-env.exe" : "amazme-env",
		),
	),
)("runs the SDK read/write guard against the actual daemon filesystem", async () => {
	const daemon = join(
		import.meta.dirname,
		"../../env/daemon/target/debug",
		process.platform === "win32" ? "amazme-env.exe" : "amazme-env",
	);
	const connection = new Connection({ command: [daemon] });
	try {
		const files = new RemoteExecutionEnv({
			connection,
			id: "sdk:daemon",
			cwd,
		});
		writeFileSync(join(cwd, "file.txt"), "original");
		const session = await sessionFor(manager(), files);
		await expect(
			tool(session, "write").execute("blind", {
				path: "file.txt",
				content: "lost",
			}),
		).rejects.toMatchObject({ code: "not_observed" });
		await tool(session, "read").execute("read", { path: "file.txt" });
		await tool(session, "write").execute("write", {
			path: "file.txt",
			content: "remote",
		});
		expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("remote");
	} finally {
		connection.close();
	}
});
