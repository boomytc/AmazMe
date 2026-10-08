import { appendFile, link, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@amazme/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@amazme/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrThrow } from "../src/env/index.ts";
import type { Context } from "@amazme/chord";
import type { FileError, FileWriteIntent, FileWriteOutcome, Result } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { ToolResultEntry } from "../src/entries.ts";
import {
	fileObservationKey,
	MAX_FILE_OBSERVATIONS,
	observedWriteIntent,
	recordFileObservation,
	type FileObservationState,
} from "../src/file-observations.ts";
import type { Harness } from "../src/harness/harness.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import {
	CodingTools,
	createEditTool,
	createReadTool,
	createWriteTool,
	FileObservationDoc,
} from "../src/tools/index.ts";
import { allEntries, chatSetup, openChat } from "./chat-support.ts";
import { closeFileToolApis, fileToolApi } from "./file-tool-api.ts";

const fault = vi.hoisted(() => ({ patch: false }));
vi.mock("../src/tools/edit-diff.ts", async (original) => {
	const diff = await original<typeof import("../src/tools/edit-diff.ts")>();
	return {
		...diff,
		generateUnifiedPatch: (...args: Parameters<typeof diff.generateUnifiedPatch>) => {
			if (fault.patch) throw new Error("patch preparation failed");
			return diff.generateUnifiedPatch(...args);
		},
	};
});

const edit = createEditTool();
const read = createReadTool();
const write = createWriteTool();
const editArgs = { path: "file.txt", edits: [{ oldText: "one", newText: "ONE" }] };

describe("conversation-owned file observations", () => {
	let env: NodeExecutionEnv;
	let cwd: string;
	const harnesses: Harness[] = [];
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "amazme-observed-tools-"));
		env = new NodeExecutionEnv({ cwd });
		await writeFile(join(cwd, "file.txt"), "one\ntwo\n");
	});
	afterEach(async () => {
		fault.patch = false;
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) await harness.close(context);
		await closeFileToolApis();
		await rm(cwd, { recursive: true, force: true });
	});

	it("requires a read before editing or replacing an existing file", async () => {
		const api = await fileToolApi(env);
		await expect(edit.execute(editArgs, api, context)).rejects.toMatchObject({ code: "not_observed" });
		await expect(write.execute({ path: "file.txt", content: "lost" }, api, context)).rejects.toMatchObject({
			code: "not_observed",
		});
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("one\ntwo\n");
	});

	it("finishes preparing the result before publishing an edit", async () => {
		const api = await fileToolApi(env);
		await read.execute({ path: "file.txt" }, api, context);
		fault.patch = true;
		await expect(edit.execute(editArgs, api, context)).rejects.toThrow("patch preparation failed");
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("one\ntwo\n");
	});

	it("refreshes the basis after each successful write and edit", async () => {
		const api = await fileToolApi(env);
		await read.execute({ path: "file.txt", limit: 1 }, api, context);
		await edit.execute(editArgs, api, context);
		await edit.execute({ path: "file.txt", edits: [{ oldText: "two", newText: "TWO" }] }, api, context);
		await write.execute({ path: "file.txt", content: "replaced" }, api, context);
		const revision = getOrThrow(await env.fileRevision("file.txt", context));
		const state = await api.snapshot(FileObservationDoc, api.conversationId, context);
		expect(state?.files[fileObservationKey(env.id, revision.path)]).toEqual({
			kind: "present",
			version: revision.version,
		});
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("replaced");
	});

	it("reports stale observations before attempting to match old text", async () => {
		const api = await fileToolApi(env);
		await read.execute({ path: "file.txt" }, api, context);
		await writeFile(join(cwd, "file.txt"), "external");
		await expect(edit.execute(editArgs, api, context)).rejects.toMatchObject({ code: "stale_version" });
		await expect(write.execute({ path: "file.txt", content: "lost" }, api, context)).rejects.toMatchObject({
			code: "stale_version",
		});
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("external");
		await read.execute({ path: "file.txt" }, api, context);
		await write.execute({ path: "file.txt", content: "after reread" }, api, context);
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("after reread");
	});

	it("keeps absence distinct from an unseen target and refuses a later external create", async () => {
		const api = await fileToolApi(env);
		await expect(read.execute({ path: "missing.txt" }, api, context)).rejects.toMatchObject({ code: "not_found" });
		await expect(
			edit.execute({ path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }, api, context),
		).rejects.toMatchObject({ code: "not_found" });
		await writeFile(join(cwd, "missing.txt"), "external");
		await expect(write.execute({ path: "missing.txt", content: "lost" }, api, context)).rejects.toMatchObject({
			code: "not_observed",
		});
		expect(await readFile(join(cwd, "missing.txt"), "utf8")).toBe("external");
	});

	it("does not borrow observations from another file namespace", async () => {
		class OtherNamespace extends NodeExecutionEnv {
			override readonly id = "node:other";
		}
		const api = await fileToolApi(env);
		await read.execute({ path: "file.txt" }, api, context);
		const other = new OtherNamespace({ cwd });
		await expect(edit.execute(editArgs, { ...api, env: other }, context)).rejects.toMatchObject({
			code: "not_observed",
		});
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("one\ntwo\n");
	});

	it("does not grant a replacement basis from an unstable growing read", async () => {
		const api = await fileToolApi(env);
		await read.execute({ path: "file.txt" }, api, context);
		const opening = env.openBinaryReader.bind(env);
		vi.spyOn(env, "openBinaryReader").mockImplementation(async (...args) => {
			const result = await opening(...args);
			if (!result.ok) return result;
			const reading = result.value.read.bind(result.value);
			result.value.read = async (...readArgs) => {
				await appendFile(join(cwd, "file.txt"), "more\n");
				return reading(...readArgs);
			};
			return result;
		});
		await read.execute({ path: "file.txt", limit: 1 }, api, context);
		await expect(write.execute({ path: "file.txt", content: "lost" }, api, context)).rejects.toMatchObject({
			code: "not_observed",
		});
	});

	it("reports publication honestly when recording its observation fails", async () => {
		const api = await fileToolApi(env);
		await read.execute({ path: "file.txt" }, api, context);
		const diagnostics: string[] = [];
		const broken = {
			...api,
			diagnostic: (item: { code?: string }) => diagnostics.push(item.code ?? ""),
			commit: async () => {
				throw new Error("storage failed");
			},
		};
		const result = await write.execute({ path: "file.txt", content: "published" }, broken, context);
		expect(result.content).toMatchObject([{ text: "Successfully wrote to file.txt" }]);
		expect(diagnostics).toEqual(["observation_unavailable"]);
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("published");
		await expect(edit.execute(editArgs, api, context)).rejects.toMatchObject({ code: "stale_version" });
	});

	it("bounds retained observations and refuses replacement using an evicted basis", async () => {
		const revision = getOrThrow(await env.fileRevision("file.txt", context));
		const state: FileObservationState = { files: {} };
		recordFileObservation(state, env.id, revision.path, { kind: "present", version: revision.version });
		for (let i = 0; i < MAX_FILE_OBSERVATIONS; i++)
			recordFileObservation(state, env.id, `other-${i}`, { kind: "absent" });
		expect(Object.keys(state.files)).toHaveLength(MAX_FILE_OBSERVATIONS);
		const intent = observedWriteIntent(revision.path, state.files[fileObservationKey(env.id, revision.path)]);
		expect(await env.writeFileChecked("file.txt", "lost", intent, context)).toMatchObject({
			ok: false,
			error: { code: "not_observed" },
		});
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("one\ntwo\n");
	});

	it.skipIf(process.platform === "win32")(
		"does not apply an observation to a retargeted alias with the same inode",
		async () => {
			await mkdir(join(cwd, "one"));
			await mkdir(join(cwd, "two"));
			await writeFile(join(cwd, "one", "file.txt"), "before");
			await link(join(cwd, "one", "file.txt"), join(cwd, "two", "file.txt"));
			await symlink("one", join(cwd, "alias"));
			const api = await fileToolApi(env);
			await read.execute({ path: "alias/file.txt" }, api, context);
			await unlink(join(cwd, "alias"));
			await symlink("two", join(cwd, "alias"));
			await expect(write.execute({ path: "alias/file.txt", content: "lost" }, api, context)).rejects.toMatchObject({
				code: "not_observed",
			});
			expect(await readFile(join(cwd, "two", "file.txt"), "utf8")).toBe("before");
		},
	);

	it("enforces the guard in real tool tasks and clears observations on a history fork", async () => {
		const setup = chatSetup();
		setup.registry.install(CodingTools);
		const opened = await openChat(new MemoryStorage(), setup, { env });
		harnesses.push(opened.harness);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", editArgs)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await (await opened.root.submit({ type: "input", content: "edit without read" }, context)).wait(context);
		let results = (await allEntries(opened.root)).filter(ToolResultEntry.is);
		expect(results.at(-1)?.data.diagnostics?.[0]?.code).toBe("not_observed");
		expect(results.at(-1)?.model?.[0]).toMatchObject({ isError: true });
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "file.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("read done"),
		]);
		await (await opened.root.submit({ type: "input", content: "read" }, context)).wait(context);
		const entries = await allEntries(opened.root);
		const forked = await opened.root.fork(entries.at(-1)!.id, { ownership: { kind: "ownerless" } }, context);
		expect(await opened.harness.snapshot(FileObservationDoc, forked.id, context)).toBeUndefined();
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", editArgs)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await (await forked.submit({ type: "input", content: "edit on fork" }, context)).wait(context);
		results = (await allEntries(forked)).filter(ToolResultEntry.is);
		expect(results.at(-1)?.data.diagnostics?.[0]?.code).toBe("not_observed");
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("one\ntwo\n");
	});

	it("restores observations from real SQLite and rechecks external changes after reopening", async () => {
		const setup = chatSetup();
		setup.registry.install(CodingTools);
		const database = join(cwd, "session.sqlite");
		let opened = await openChat(await openNodeSqliteStorage(database), setup, { env });
		harnesses.push(opened.harness);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "file.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await (await opened.root.submit({ type: "input", content: "read" }, context)).wait(context);
		const before = await opened.harness.snapshot(FileObservationDoc, opened.root.id, context);
		await opened.harness.close(context);
		opened = await openChat(await openNodeSqliteStorage(database), setup, { env });
		harnesses.push(opened.harness);
		expect(await opened.harness.snapshot(FileObservationDoc, opened.root.id, context)).toEqual(before);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", editArgs)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await (await opened.root.submit({ type: "input", content: "edit without reread" }, context)).wait(context);
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("ONE\ntwo\n");
		await opened.harness.close(context);
		await writeFile(join(cwd, "file.txt"), "external");
		opened = await openChat(await openNodeSqliteStorage(database), setup, { env });
		harnesses.push(opened.harness);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "file.txt", content: "lost" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await (await opened.root.submit({ type: "input", content: "replace" }, context)).wait(context);
		const results = (await allEntries(opened.root)).filter(ToolResultEntry.is);
		expect(results.at(-1)?.data.diagnostics?.[0]?.code).toBe("stale_version");
		expect(results.at(-1)?.model?.[0]).toMatchObject({ isError: true });
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("external");
	});

	it("requires a reread after an aborted task finishes a physical write and the session reopens", async () => {
		const entered = Promise.withResolvers<void>();
		let cancellationObserved = false;
		const release = Promise.withResolvers<void>();
		class FinishingWriteEnv extends NodeExecutionEnv {
			override async writeFileChecked(
				path: string,
				content: string | Uint8Array,
				intent: FileWriteIntent,
				writeContext: Context,
			): Promise<Result<FileWriteOutcome, FileError>> {
				if (content === "ONE\ntwo\n") {
					writeContext.abortSignal?.addEventListener(
						"abort",
						() => {
							cancellationObserved = true;
						},
						{ once: true },
					);
					entered.resolve();
					await release.promise;
					// A backend operation that already began can complete while the owning task is being aborted.
					return super.writeFileChecked(path, content, intent, context);
				}
				return super.writeFileChecked(path, content, intent, writeContext);
			}
		}
		const finishing = new FinishingWriteEnv({ cwd });
		const setup = chatSetup();
		setup.registry.install(CodingTools);
		const database = join(cwd, "cancel.sqlite");
		let opened = await openChat(await openNodeSqliteStorage(database), setup, { env: finishing });
		harnesses.push(opened.harness);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "file.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await (await opened.root.submit({ type: "input", content: "read" }, context)).wait(context);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", editArgs)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const submission = await opened.root.submit({ type: "input", content: "edit" }, context);
		await entered.promise;
		const aborting = opened.root.abort(context);
		try {
			await vi.waitFor(() => expect(cancellationObserved).toBe(true), { timeout: 3000 });
		} finally {
			release.resolve();
		}
		await aborting;
		expect((await submission.wait(context)).status).not.toBe("done");
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("ONE\ntwo\n");
		await opened.harness.close(context);
		opened = await openChat(await openNodeSqliteStorage(database), setup, { env: finishing });
		harnesses.push(opened.harness);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "file.txt", content: "lost" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await (await opened.root.submit({ type: "input", content: "replace" }, context)).wait(context);
		const results = (await allEntries(opened.root)).filter(ToolResultEntry.is);
		expect(results.at(-1)?.data.diagnostics?.[0]?.code).toBe("stale_version");
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("ONE\ntwo\n");
	});
});
