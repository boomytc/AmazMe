import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { JsonRepresentation } from "@amazme/chord";
import { copyJson } from "@amazme/chord";
import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@amazme/ai";
import {
	createSession,
	defineDoc,
	defineDocFamily,
	defineTask,
	defineTool,
	type Harness,
	LiveDoc,
	MemoryStorage,
	NestedCallDoc,
	type NestedToolExecutionResult,
	type TaskId,
	ToolTask,
	type ToolTaskResult,
} from "@amazme/durable";
import { afterEach, describe, expect, it } from "vitest";
import type { Transaction } from "../src/session/transaction.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { chatSetup, openChat } from "./chat-support.ts";
import { addTask, addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";
import { createTempDir } from "./temp-dir.ts";

const DONE = fauxAssistantMessage([fauxText("done")]);
const BATCH = fauxAssistantMessage([fauxToolCall("batch", {}, { id: "batch" })], { stopReason: "toolUse" });
const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.close(context)));
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

const LegacyCalls = defineDoc<{ calls: Record<string, TaskId<ToolTaskResult>> }>({
	kind: "amazme.tool.nested",
	version: 1,
	scope: "task",
	initial: () => ({ calls: {} }),
});
type Stored = { result: JsonRepresentation<NestedToolExecutionResult> };
const LegacyResult = defineDocFamily<Stored, Stored>({
	kind: "amazme.tool.nested-result",
	version: 1,
	scope: "task",
	family: true,
	initial: (seed) => seed,
});

/** Turn a paused current session into the exact index/result layout shipped before the upstream change. */
async function legacyLayout(path: string, parent: TaskId, keys: readonly string[]): Promise<void> {
	const session = createSession(await openNodeSqliteStorage(path));
	try {
		await session.commit(async (tx) => {
			const record = (await tx.task(parent))!;
			if (record.state.status === "terminal" || record.state.status === "completing")
				throw new Error("Expected live caller");
			(tx as Transaction).setTask({ ...record, state: record.state, memos: {} });
			for (const key of keys) {
				const state = await tx.doc(NestedCallDoc, parent, key, null);
				if (state.taskId === undefined) throw new Error("Missing nested task");
				(await tx.doc(LegacyCalls, parent)).calls[key] = state.taskId;
				if (state.result !== undefined)
					await tx.doc(LegacyResult, parent, String(state.taskId), { result: copyJson(state.result) });
				await tx.retireDoc(NestedCallDoc, parent, key);
			}
		}, context);
	} finally {
		await session.close(context);
	}
}

async function database(): Promise<string> {
	const directory = createTempDir("amazme-nested-upgrade-");
	directories.push(directory);
	return join(directory, "session.sqlite");
}

describe("nested call documents", () => {
	it("writes one independent document per key, rather than rewriting a shared index", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			defineTool({
				name: "leaf",
				description: "leaf",
				parameters: Type.Object({}),
				execute: async () => ({ output: [{ type: "text", text: "ok" }] }),
			}),
		);
		addTool(
			setup.registry,
			defineTool({
				name: "batch",
				description: "batch",
				parameters: Type.Object({}),
				execute: async (_args, api, ctx) => {
					await Promise.all([api.executeTool("leaf", {}, ctx), api.executeTool("leaf", {}, ctx, { key: "named" })]);
					return {};
				},
			}),
		);
		setup.faux.setResponses([BATCH, DONE]);
		const storage = new MemoryStorage();
		const created: { kind: string; key?: string }[] = [];
		const commit = storage.commit.bind(storage);
		storage.commit = (writes, ctx) => {
			for (const write of writes) {
				if (write.type === "document.create" && write.record.kind.startsWith("amazme.tool."))
					created.push({ kind: write.record.kind, key: write.record.key });
			}
			return commit(writes, ctx);
		};
		const { harness, root } = await openChat(storage, setup);
		harnesses.push(harness);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(created).toEqual([
			{ kind: NestedCallDoc.definition.kind, key: "1" },
			{ kind: NestedCallDoc.definition.kind, key: "named" },
		]);
	});

	it("rejects admission after the caller's abort mark without creating a document", async () => {
		const setup = chatSetup();
		const started = deferred();
		const marked = deferred();
		let caller: TaskId | undefined;
		let rejected: unknown;
		addTool(
			setup.registry,
			defineTool({
				name: "batch",
				description: "batch",
				parameters: Type.Object({}),
				execute: async (_args, api) => {
					caller = api.taskId;
					started.resolve();
					await marked.promise;
					try {
						await api.executeTool("missing", {}, context);
					} catch (error) {
						rejected = error;
					}
					return {};
				},
			}),
		);
		setup.faux.setResponses([BATCH, DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harnesses.push(harness);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await started.promise;
		await harness.commit(async (tx) => {
			const record = (await tx.task(caller!))!;
			(tx as Transaction).setTask({ ...record, abortRequested: true });
		}, context);
		marked.resolve();
		await submission.wait(context);
		expect(String(rejected)).toMatch(/abort mark|aborted|has settled/);
		expect(await harness.snapshot(NestedCallDoc, caller!, "1", context)).toBeUndefined();
	});

	it.each([false, true])(
		"migrates old SQLite receipts without rerunning completed tools (caller skips on resume: %s)",
		async (skip) => {
			const path = await database();
			const setup = chatSetup();
			const started = deferred();
			let attempt = 0;
			let runs = 0;
			let caller: TaskId | undefined;
			const results: NestedToolExecutionResult[] = [];
			addTool(
				setup.registry,
				defineTool({
					name: "leaf",
					description: "leaf",
					parameters: Type.Object({}),
					execute: async () => {
						runs++;
						return { output: [{ type: "text", text: "already executed" }] };
					},
				}),
			);
			addTool(
				setup.registry,
				defineTool({
					name: "batch",
					description: "batch",
					parameters: Type.Object({}),
					replay: "safe",
					execute: async (_args, api, ctx) => {
						caller = api.taskId;
						attempt++;
						if (attempt === 1 || !skip) results.push(await api.executeTool("leaf", {}, ctx, { key: "saved" }));
						if (attempt === 1) {
							started.resolve();
							await aborted(ctx.abortSignal!);
						}
						return {};
					},
				}),
			);
			setup.faux.setResponses([BATCH, DONE]);
			let opened = await openChat(await openNodeSqliteStorage(path), setup);
			harnesses.push(opened.harness);
			await opened.root.submit({ type: "input", content: "go" }, context);
			await started.promise;
			await opened.harness.close(context);
			await legacyLayout(path, caller!, ["saved"]);
			opened = await openChat(await openNodeSqliteStorage(path), setup);
			harnesses.push(opened.harness);
			expect((await opened.harness.snapshot(NestedCallDoc, caller!, "saved", context))?.result?.structuredOutput).toBe(
				"already executed",
			);
			expect(await opened.harness.snapshot(LegacyCalls, caller!, context)).toBeUndefined();
			expect(await opened.harness.snapshot(LegacyResult, caller!, String(results[0]!.taskId), context)).toBeUndefined();
			// Reopening twice before scheduling verifies migration is committed, not only an in-memory fallback.
			await opened.harness.close(context);
			opened = await openChat(await openNodeSqliteStorage(path), setup);
			harnesses.push(opened.harness);
			await opened.harness.waitForIdle(context);
			expect(runs).toBe(1);
			if (!skip) expect(results[1]).toEqual(results[0]);
			expect(await opened.harness.snapshot(NestedCallDoc, caller!, "saved", context)).toBeUndefined();
			expect((await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.nestedTools).toBeUndefined();
		},
	);

	it("reattaches an unfinished legacy child and interrupts its unsafe execution without running it twice", async () => {
		const path = await database();
		const setup = chatSetup();
		const started = deferred();
		let caller: TaskId | undefined;
		let child: TaskId | undefined;
		let received: NestedToolExecutionResult | undefined;
		let runs = 0;
		addTool(
			setup.registry,
			defineTool({
				name: "leaf",
				description: "leaf",
				parameters: Type.Object({}),
				execute: async (_args, api, ctx) => {
					runs++;
					child = api.taskId;
					started.resolve();
					await aborted(ctx.abortSignal!);
					return {};
				},
			}),
		);
		addTool(
			setup.registry,
			defineTool({
				name: "batch",
				description: "batch",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async (_args, api, ctx) => {
					caller = api.taskId;
					received = await api.executeTool("leaf", {}, ctx, { key: "pending" });
					return {};
				},
			}),
		);
		setup.faux.setResponses([BATCH, DONE]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		harnesses.push(opened.harness);
		await opened.root.submit({ type: "input", content: "go" }, context);
		await started.promise;
		await opened.harness.close(context);
		await legacyLayout(path, caller!, ["pending"]);
		opened = await openChat(await openNodeSqliteStorage(path), setup);
		harnesses.push(opened.harness);
		await opened.harness.waitForIdle(context);
		expect(runs).toBe(1);
		expect(received).toMatchObject({ taskId: child, isError: true });
		expect(received?.diagnostics).toContainEqual(expect.objectContaining({ code: "interrupted" }));
	});

	it("migrates a completed result for an ordinary workflow parent already waiting for its child", async () => {
		const path = await database();
		const setup = chatSetup();
		const started = deferred();
		let resume = false;
		let runs = 0;
		const Parent = defineTask<null, { phase: "call" } | { phase: "wait"; child: TaskId<ToolTaskResult> }, string>({
			name: "test.workflow-parent",
			version: 1,
			initial: () => ({ phase: "call" }),
			phases: {
				call: async (_task, runtime, ctx) => {
					await runtime.commit(async (tx) => {
						const child = await tx.createTask(
							ToolTask,
							{
								kind: "nested",
								parent: runtime.taskId,
								parentCallId: "workflow",
								key: "command",
								call: { type: "toolCall", id: "workflow/command", name: "leaf", arguments: {} },
							},
							{ ownership: { kind: "task", taskId: runtime.taskId } },
						);
						return { status: "running", checkpoint: { phase: "wait", child } };
					}, ctx);
				},
				wait: async (task, runtime, ctx) => {
					await runtime.waitForTask(task.state.checkpoint.child, ctx);
					if (!resume) {
						started.resolve();
						await aborted(runtime.signal);
						return;
					}
					const result = (await runtime.snapshot(NestedCallDoc, runtime.taskId, "command", ctx))?.result;
					await runtime.commit(
						() => ({
							status: "terminal",
							outcome: {
								status: "completed",
								result: String(result?.structuredOutput),
							},
						}),
						ctx,
					);
				},
			},
			abort: async (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		});
		addTask(setup.registry, Parent);
		addTool(
			setup.registry,
			defineTool({
				name: "leaf",
				description: "leaf",
				parameters: Type.Object({}),
				execute: async () => {
					runs++;
					return { output: [{ type: "text", text: "workflow done" }] };
				},
			}),
		);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		harnesses.push(opened.harness);
		const parent = await opened.root.commit(
			(tx) => tx.createTask(Parent, null, { ownership: { kind: "conversation" } }),
			context,
		);
		opened.harness.resume();
		await started.promise;
		await opened.harness.close(context);
		await legacyLayout(path, parent, ["command"]);
		resume = true;
		opened = await openChat(await openNodeSqliteStorage(path), setup);
		harnesses.push(opened.harness);
		expect((await opened.harness.waitForTask(parent, context)).state.outcome.result).toBe("workflow done");
		expect(runs).toBe(1);
	});
});
