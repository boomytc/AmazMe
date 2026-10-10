import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCancel } from "@amazme/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@amazme/ai";
import {
	AgentDoc,
	defineTool,
	LiveDoc,
	MemoryStorage,
	NestedResultDoc,
	ToolResultEntry,
	ToolTask,
	defineTask,
	watchEvents,
	GenerationTask,
} from "@amazme/durable";
import type {
	AgentEvent,
	Harness,
	ToolExecutionApi,
	ToolExecutionResult,
	NestedToolExecutionResult,
	ToolRegistration,
} from "@amazme/durable";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_NESTED_TOOL_CALLS, MAX_NESTED_TOOL_DEPTH } from "../src/harness/tool.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, chatSetup, openChat } from "./chat-support.ts";
import { addHooks, addTool } from "./harness-support.ts";
import { context, flush } from "./session-support.ts";
import { aborted, deferred, eventually, settled } from "./task-support.ts";

const harnesses = new Set<Harness>();
const directories = new Set<string>();
const DONE = fauxAssistantMessage([fauxText("done")]);
const CALL = fauxAssistantMessage([fauxToolCall("parent", {}, { id: "parent-call" })], { stopReason: "toolUse" });
const text = (value: string): ToolExecutionResult => ({
	output: [{ type: "text", text: value }],
});

function parent(execute: ToolRegistration["execute"]): ToolRegistration {
	return defineTool({ name: "parent", description: "Nested caller", parameters: Type.Object({}), execute });
}

async function open(tools: ToolRegistration[]) {
	const setup = chatSetup();
	for (const tool of tools) addTool(setup.registry, tool);
	setup.faux.setResponses([CALL, DONE]);
	const opened = await openChat(new MemoryStorage(), setup);
	harnesses.add(opened.harness);
	return { ...opened, setup };
}

afterEach(async () => {
	for (const harness of harnesses) await harness.close(context);
	harnesses.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

describe("nested tool execution", () => {
	it("separates the model loadout, callable tools and bounded catalog", async () => {
		const names = ["direct", "model-only", "codemode", "deferred", "hidden"] as const;
		const { root } = await open(
			names.map((exposure) =>
				defineTool({
					name: exposure,
					description: exposure,
					exposure,
					parameters: Type.Object({}),
					execute: async () => text(exposure),
				}),
			),
		);
		const agent = await root.agent(context);
		expect(agent.tools.map((tool) => tool.name)).toEqual(["direct", "model-only"]);
		expect(agent.callable.map((tool) => tool.name)).toEqual(["direct", "codemode", "deferred"]);
		expect(agent.catalog.map((tool) => tool.name)).toEqual(["direct", "model-only", "codemode", "deferred"]);
		await root.commit(async (tx) => {
			(await tx.doc(AgentDoc, root.id)).tools = { only: ["hidden", "codemode", "model-only"], exclude: ["codemode"] };
		}, context);
		expect((await root.agent(context)).tools.map((tool) => tool.name)).toEqual(["model-only"]);
		expect((await root.agent(context)).callable.map((tool) => tool.name)).toEqual(["deferred"]);
		await root.commit(async (tx) => {
			(await tx.doc(AgentDoc, root.id)).tools = { allow: ["direct"], add: ["codemode"] };
		}, context);
		expect((await root.agent(context)).catalog.map((tool) => tool.name)).toEqual(["direct"]);
	});

	it("uses validation and both hooks, preserves structured data, and stores child evidence without model messages", async () => {
		let received: NestedToolExecutionResult | undefined;
		let savedApi: ToolExecutionApi | undefined;
		const payload = { value: "x".repeat(2048) };
		const observed: string[] = [];
		const { root, harness, setup } = await open([
			parent(async (_args, api, ctx) => {
				savedApi = api;
				received = await api.executeTool("child", { value: "original" }, ctx);
				return text("parent completed");
			}),
			defineTool({
				name: "child",
				description: "Child",
				exposure: "codemode",
				parameters: Type.Object({ value: Type.String() }),
				outputLimits: { maxBytes: 20 },
				structuredOutputSchema: Type.Object({ value: Type.String() }),
				execute: async (args) => {
					observed.push(args.value);
					return { ...text("y".repeat(200)), structuredOutput: payload };
				},
			}),
		]);
		addHooks(setup.registry, ToolTask, {
			beforeTool: (call) => (call.name === "child" ? { arguments: { value: "rewritten" } } : undefined),
			afterTool: (call, result) => {
				observed.push(`after:${call.name}`);
				return result;
			},
		});
		const stream = await watchEvents(harness, root.id, context);
		const events: AgentEvent[] = [];
		stream.start(async (batch) => {
			events.push(...batch);
		});
		expect((await (await root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe("done");
		await stream.stop();
		expect(events.find((event) => event.type === "tool_execution_start" && event.toolName === "child")).toMatchObject(
			{
				parentToolCallId: "parent-call",
				args: { value: "rewritten" },
			},
		);
		expect(events.find((event) => event.type === "tool_execution_end" && event.toolName === "child")).toMatchObject({
			parentToolCallId: "parent-call",
			result: { structuredOutput: payload },
		});
		expect(observed).toEqual(["rewritten", "after:child", "after:parent"]);
		expect(received?.structuredOutput).toEqual(payload);
		expect(received).not.toHaveProperty("output");
		expect(received?.diagnostics).toContainEqual(expect.objectContaining({ code: "truncated" }));
		const receivedData = received?.structuredOutput;
		if (receivedData !== null && typeof receivedData === "object" && !Array.isArray(receivedData))
			receivedData.value = "caller mutation";
		const entries = await allEntries(root);
		const record = await harness.getTask(received!.taskId, context);
		const parentEntry = entries.find(ToolResultEntry.is)!;
		expect(record?.owner).toBe(parentEntry.byTaskId);
		expect(record?.state.outcome).toEqual({
			status: "completed",
			result: { kind: "nested" },
		});
		expect(
			await harness.snapshot(NestedResultDoc, parentEntry.byTaskId!, String(received!.taskId), context),
		).toBeUndefined();
		expect(entries.filter(ToolResultEntry.is)).toHaveLength(1);
		expect((await root.context(context)).messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		await expect(savedApi!.executeTool("child", {}, context)).rejects.toThrow("has settled");
	});

	it("rejects invalid, blocked, hidden, model-only and excluded calls before their executor", async () => {
		const results: NestedToolExecutionResult[] = [];
		let executions = 0;
		const { root, setup } = await open([
			parent(async (_args, api, ctx) => {
				for (const [name, args] of [
					["child", {}],
					["child", { value: "blocked" }],
					["hidden", {}],
					["model", {}],
					["excluded", {}],
					["inactive", {}],
				] as const)
					results.push(await api.executeTool(name, args, ctx));
				return text("done");
			}),
			...(["child", "hidden", "model", "excluded", "inactive"] as const).map((name) =>
				defineTool({
					name,
					description: name,
					exposure:
						name === "hidden"
							? "hidden"
							: name === "model"
								? "model-only"
								: name === "inactive"
									? "direct"
									: "deferred",
					defaultActive: name !== "inactive",
					parameters: name === "child" ? Type.Object({ value: Type.String() }) : Type.Object({}),
					execute: async () => {
						executions++;
						return text("ran");
					},
				}),
			),
		]);
		await root.commit(async (tx) => {
			(await tx.doc(AgentDoc, root.id)).tools = { exclude: ["excluded"] };
		}, context);
		addHooks(setup.registry, ToolTask, {
			beforeTool: (call) => (call.name === "child" ? { block: "policy" } : undefined),
		});
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(executions).toBe(0);
		expect(results.map((result) => result.diagnostics?.[0]?.code)).toEqual([
			"invalid_arguments",
			"blocked",
			"tool_unavailable",
			"tool_unavailable",
			"tool_unavailable",
			"tool_unavailable",
		]);
		expect(results.every((result) => result.isError)).toBe(true);
	});

	it("keeps round hooks and termination scoped to the model's outer calls", async () => {
		let observed: readonly number[] = [];
		const { root, setup } = await open([
			parent(async (_args, api, ctx) => {
				await api.executeTool("child", {}, ctx);
				return { ...text("done"), control: { terminate: true } };
			}),
			defineTool({
				name: "child",
				description: "Child",
				exposure: "codemode",
				parameters: Type.Object({}),
				execute: async () => text("child"),
			}),
		]);
		addHooks(setup.registry, GenerationTask, {
			afterTools: (_assistant, entries) => {
				observed = entries;
			},
		});
		expect((await (await root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe("done");
		const entries = await allEntries(root);
		expect(observed).toEqual(entries.filter(ToolResultEntry.is).map((entry) => entry.id));
		expect(setup.faux.state.callCount).toBe(1);
	});

	it("drops original structured data when afterTool rewrites content", async () => {
		let received: NestedToolExecutionResult | undefined;
		const { root, setup } = await open([
			parent(async (_args, api, ctx) => {
				received = await api.executeTool("child", {}, ctx);
				return text("done");
			}),
			defineTool({
				name: "child",
				description: "Secret",
				structuredOutputSchema: Type.Object({ secret: Type.Boolean() }),
				exposure: "codemode",
				parameters: Type.Object({}),
				execute: async () => ({
					...text("secret"),
					structuredOutput: { secret: true },
				}),
			}),
		]);
		addHooks(setup.registry, ToolTask, {
			afterTool: (call, result) => (call.name === "child" ? { ...result, ...text("redacted") } : undefined),
		});
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(received).toMatchObject({ isError: true });
		expect(received?.structuredOutput).toBeUndefined();
		expect((await allEntries(root)).filter(ToolResultEntry.is)).toHaveLength(1);
	});

	it.each(["caller cancellation", "unawaited return"])("waits for child cleanup after %s", async (mode) => {
		const started = deferred();
		const cleaning = deferred();
		const release = deferred();
		const cleaned = deferred();
		const caller = withCancel(context);
		const { root } = await open([
			parent(async (_args, api, ctx) => {
				const child = api.executeTool("child", {}, mode === "caller cancellation" ? caller.context : ctx);
				// The parent deliberately stops awaiting in the second scenario.
				void child.catch(() => {});
				await started.promise;
				if (mode === "caller cancellation") {
					caller.cancel();
					await child.catch(() => {});
				}
				return text("done");
			}),
			defineTool({
				name: "child",
				description: "Cancellable",
				exposure: "codemode",
				parameters: Type.Object({}),
				execute: async (_args, _api, ctx) => {
					started.resolve();
					try {
						await aborted(ctx.abortSignal!);
					} finally {
						cleaning.resolve();
						await release.promise;
						cleaned.resolve();
					}
					return text("unreachable");
				},
			}),
		]);
		const completion = (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		try {
			await cleaning.promise;
			expect(await settled(completion)).toBe(false);
			expect(await settled(cleaned.promise)).toBe(false);
		} finally {
			release.resolve();
		}
		expect((await completion).status).toBe("done");
		expect(await settled(cleaned.promise)).toBe(true);
		const tasks = await root.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context);
		expect(
			tasks.items.find(
				(task) =>
					task.input !== null &&
					typeof task.input === "object" &&
					!Array.isArray(task.input) &&
					task.input.kind === "nested",
			)?.state.outcome.status,
		).toBe("aborted");
	});

	it.each(["tool", "global"])(
		"lets the caller sequence nested tools independently of %s round policy",
		async (mode) => {
			const started: string[] = [];
			const first = deferred();
			const second = deferred();
			const { root, setup } = await open([
				parent(async (_args, api, ctx) => {
					for (const name of ["a", "b", "c"]) await api.executeTool(name, {}, ctx);
					return text("done");
				}),
				...["a", "b", "c"].map((name) =>
					defineTool({
						name,
						description: name,
						exposure: "codemode",
						parameters: Type.Object({}),
						executionMode: mode === "tool" && name === "b" ? "sequential" : "parallel",
						execute: async () => {
							started.push(name);
							if (name === "a") await first.promise;
							if (name === "b") await second.promise;
							return text(name);
						},
					}),
				),
			]);
			if (mode === "global") setup.settings.toolExecution = "sequential";
			const completion = (await root.submit({ type: "input", content: "go" }, context)).wait(context);
			try {
				await eventually(() => started.length === 1);
				expect(started).toEqual(["a"]);
				first.resolve();
				await eventually(() => started.length === 2);
				expect(started).toEqual(["a", "b"]);
			} finally {
				first.resolve();
				second.resolve();
			}
			expect((await completion).status).toBe("done");
			expect(started).toEqual(["a", "b", "c"]);
		},
	);

	it("bounds recursive depth and the number of child calls", async () => {
		let count = 0;
		let limited: string | undefined;
		const { root } = await open([
			parent(async (_args, api, ctx) => {
				await api.executeTool("recursive", {}, ctx);
				for (let index = 1; index < MAX_NESTED_TOOL_CALLS; index++) await api.executeTool("missing", {}, ctx);
				try {
					await api.executeTool("missing", {}, ctx);
				} catch (error) {
					limited = String(error);
				}
				return text("done");
			}),
			defineTool({
				name: "recursive",
				description: "Recursive",
				exposure: "codemode",
				parameters: Type.Object({}),
				execute: async (_args, api, ctx) => {
					count++;
					const result = await api.executeTool("recursive", {}, ctx);
					return result.isError ? result : text("recursive");
				},
			}),
		]);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(count).toBe(MAX_NESTED_TOOL_DEPTH);
		expect(limited).toContain(`exceed ${MAX_NESTED_TOOL_CALLS}`);
		const tasks = await root.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 1000), context);
		expect(
			tasks.items.filter(
				(task) =>
					task.input !== null &&
					typeof task.input === "object" &&
					!Array.isArray(task.input) &&
					task.input.kind === "nested",
			),
		).toHaveLength(MAX_NESTED_TOOL_CALLS + MAX_NESTED_TOOL_DEPTH - 1);
	});

	it("cancels an unadmitted call without delaying independent nested calls", async () => {
		const started: string[] = [];
		const first = deferred();
		const queued = withCancel(context);
		const cancelled = deferred();
		const { root } = await open([
			parent(async (_args, api, ctx) => {
				const a = api.executeTool("a", {}, ctx);
				const b = api.executeTool("b", {}, queued.context).catch(() => {
					cancelled.resolve();
				});
				const c = api.executeTool("c", {}, ctx);
				queued.cancel();
				await Promise.all([a, b, c]);
				return text("done");
			}),
			...["a", "b", "c"].map((name) =>
				defineTool({
					name,
					description: name,
					exposure: "codemode",
					parameters: Type.Object({}),
					executionMode: name === "b" ? "sequential" : "parallel",
					execute: async () => {
						started.push(name);
						if (name === "a") await first.promise;
						return text(name);
					},
				}),
			),
		]);
		const completion = (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		try {
			await cancelled.promise;
			await eventually(() => started.includes("a"));
			expect(started).toEqual(["a", "c"]);
		} finally {
			first.resolve();
		}
		await completion;
		expect(started).toEqual(["a", "c"]);
	});

	it("allows independent calls to run together and the parent activates deferred tools", async () => {
		const started: string[] = [];
		const release = deferred();
		const { root } = await open([
			parent(async (_args, api, ctx) => {
				await Promise.all(["a", "b"].map((name) => api.executeTool(name, {}, ctx)));
				return { ...text("done"), control: { addTools: ["deferred"] } };
			}),
			...["a", "b"].map((name) =>
				defineTool({
					name,
					description: name,
					exposure: "codemode",
					parameters: Type.Object({}),
					execute: async () => {
						started.push(name);
						await release.promise;
						return { ...text(name), control: { addTools: ["deferred"] } };
					},
				}),
			),
			defineTool({
				name: "deferred",
				description: "Loaded",
				exposure: "deferred",
				parameters: Type.Object({}),
				execute: async () => text("loaded"),
			}),
		]);
		const completion = (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		try {
			await eventually(() => started.length === 2);
			expect(started).toEqual(["a", "b"]);
		} finally {
			release.resolve();
		}
		await completion;
		expect((await root.agent(context)).tools.map((tool) => tool.name)).toEqual(["parent", "deferred"]);
	});

	it("restricts invocation cancellation to directly owned tasks and rejects late calls", async () => {
		let late: (() => Promise<unknown>) | undefined;
		const { root, harness, setup } = await open([]);
		const child = defineTask<null, { phase: "run" }, null>({
			name: "child-task",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime) => {
					await aborted(runtime.signal);
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		const owner = defineTask<null, { phase: "run" }, null>({
			name: "owner-task",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, ctx) => {
					let owned!: Parameters<typeof runtime.abortOwned>[0];
					let unrelated!: typeof owned;
					await runtime.commit(async (tx) => {
						owned = await tx.createTask(child, null, { ownership: { kind: "task", taskId: runtime.taskId } });
						unrelated = await tx.createTask(child, null, { ownership: { kind: "conversation" } });
					}, ctx);
					await expect(runtime.abortOwned(unrelated, ctx)).rejects.toThrow("is not owned");
					await runtime.abortOwned(owned, ctx);
					expect((await runtime.waitForTask(owned, ctx)).state.outcome.status).toBe("aborted");
					late = () => runtime.abortOwned(owned, ctx);
					await runtime.commit(
						() => ({
							status: "terminal",
							outcome: { status: "completed", result: null },
						}),
						ctx,
					);
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		setup.registry.install({ name: "owned-cancellation", tasks: [child, owner] });
		const id = await root.commit((tx) => tx.createTask(owner, null, { ownership: { kind: "conversation" } }), context);
		await harness.waitForTask(id, context);
		await flush();
		await expect(late!()).rejects.toThrow("ended");
		await root.abort(context);
	});

	it("does not replay interrupted unsafe parents or children when SQLite is reopened", async () => {
		const directory = await mkdtemp(join(tmpdir(), "amazme-nested-recovery-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const setup = chatSetup();
		const started = deferred();
		let count = 0;
		addTool(
			setup.registry,
			parent(async (_args, api, ctx) => api.executeTool("child", {}, ctx)),
		);
		addTool(
			setup.registry,
			defineTool({
				name: "child",
				description: "Unsafe",
				exposure: "codemode",
				parameters: Type.Object({}),
				execute: async (_args, _api, ctx) => {
					count++;
					started.resolve();
					await aborted(ctx.abortSignal!);
					return text("unreachable");
				},
			}),
		);
		setup.faux.setResponses([CALL, DONE]);
		const first = await openChat(await openNodeSqliteStorage(path), setup);
		harnesses.add(first.harness);
		const submission = await first.root.submit({ type: "input", content: "go" }, context);
		await started.promise;
		await first.harness.close(context);
		harnesses.delete(first.harness);
		const reopened = await openChat(await openNodeSqliteStorage(path), setup);
		harnesses.add(reopened.harness);
		reopened.harness.resume();
		const restored = await reopened.harness.submission(submission.id, context);
		await restored!.wait(context);
		expect(count).toBe(1);
		const entries = await allEntries(reopened.root);
		expect(entries.find(ToolResultEntry.is)?.data.diagnostics).toContainEqual(
			expect.objectContaining({ code: "interrupted" }),
		);
		const tasks = await reopened.root.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context);
		expect(
			tasks.items.find(
				(task) =>
					task.input !== null &&
					typeof task.input === "object" &&
					!Array.isArray(task.input) &&
					task.input.kind === "nested",
			)?.state.outcome.status,
		).toBe("aborted");
	});

	it("retires nested structured output and reopens the model result from actual SQLite storage", async () => {
		const directory = await mkdtemp(join(tmpdir(), "amazme-nested-tools-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const setup = chatSetup();
		addTool(
			setup.registry,
			parent(async (_args, api, ctx) => {
				const nested = await api.executeTool("child", {}, ctx);
				expect(nested.structuredOutput).toEqual({ value: 42 });
				return text("parent");
			}),
		);
		addTool(
			setup.registry,
			defineTool({
				name: "child",
				description: "Child",
				structuredOutputSchema: Type.Object({ value: Type.Number() }),
				exposure: "codemode",
				parameters: Type.Object({}),
				execute: async () => ({
					...text("child"),
					structuredOutput: { value: 42 },
				}),
			}),
		);
		setup.faux.setResponses([CALL, DONE]);
		const first = await openChat(await openNodeSqliteStorage(path), setup);
		harnesses.add(first.harness);
		await (await first.root.submit({ type: "input", content: "go" }, context)).wait(context);
		await first.harness.close(context);
		harnesses.delete(first.harness);
		const reopened = await openChat(await openNodeSqliteStorage(path), setup);
		harnesses.add(reopened.harness);
		const entries = await allEntries(reopened.root);
		expect(entries.filter(ToolResultEntry.is)).toHaveLength(1);
		expect(entries.find(ToolResultEntry.is)?.model?.[0].content).toEqual([{ type: "text", text: "parent" }]);
	});
});
