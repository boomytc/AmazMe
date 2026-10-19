import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@amazme/agent";
import { createAssistantMessageEventStream, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type AssistantMessage, type FauxResponseStep, type Model } from "@amazme/ai";
import { makeStrictJsonSchema } from "@amazme/ai/api/constrained-sampling";
import { replicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT, TODO_CONTEXT } from "@amazme/chord/context";
import { AgentDoc, BranchSummaryEntry, createRegistry, defineExtension, defineTask, Harness, InboxDoc, LiveDoc, type Conversation, type ConversationId, type EntryRecord, UserEntry } from "@amazme/durable";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";
import { afterEach, describe, expect, test } from "vitest";
import { Subagent } from "../src/durable/subagent.ts";
import { SubagentOwner, SubagentRun } from "../src/durable/subagent-run.ts";
import { createAgentController } from "../src/core/plugins/agent-controller-provider.ts";
import { type ConversationsState, IDLE_LANE } from "../src/durable/conversation-view.ts";
import { createConversationsService } from "../src/host/services/conversations-provider.ts";
import { navigateTree, readReturnPoints, readSummaries } from "../src/durable/session-surface.ts";
import { abortArchivedForks, createForkArchiveGate, ForkManagementDoc, parseConversationId } from "../src/durable/fork-management.ts";
import { pendingResponse } from "./experimental-durable-support.ts";

/**
 * The conversation list, the live task graph, and stored history, over a real Harness driven by the
 * faux provider. A subagent call needs a model to decide on it, so this is the level that can drive
 * one: the scripted assistant asks for the `subagent` tool, and the child conversation it creates is
 * what the list and the task graph must report.
 */
const directories = new Set<string>();
const Hold = defineTask<Record<string, never>, { phase: "hold" }, null>({
	name: "test.fork.hold", version: 1, initial: () => ({ phase: "hold" }),
	phases: { hold: async (_task, runtime) => {
		if (!runtime.signal.aborted) await new Promise<void>(resolve => runtime.signal.addEventListener("abort", () => resolve(), { once: true }));
	} },
	abort: async (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
const Sleeper = defineTask<{ at: number }, { phase: "sleep" }, null>({
	name: "test.fork.sleeper", version: 1, initial: () => ({ phase: "sleep" }),
	phases: { sleep: (task, runtime, context) => runtime.sleepUntil(task.input.at, task.state.checkpoint, context) },
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

async function makeDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

const summaryModel: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

function summaryStream(text: string): StreamFn {
	const message: AssistantMessage = {
		...fauxAssistantMessage(""),
		content: [{ type: "text", text }],
		api: summaryModel.api,
		provider: summaryModel.provider,
		model: summaryModel.id,
		stopReason: "stop",
	};
	return () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
		return stream;
	};
}

/** A harness with the subagent tool and a scripted provider, and the conversations service on top. */
async function openConversations(
	existing?: string,
	branch?: { readonly skipPrompt?: boolean; readonly streamFn?: StreamFn },
): Promise<{
	readonly harness: Harness;
	readonly directory: string;
	readonly rootId: string;
	readonly state: ReturnType<typeof replicatedState<ConversationsState>>;
	readonly service: ReturnType<typeof createConversationsService>;
	readonly faux: ReturnType<typeof fauxProvider>;
	close(): Promise<void>;
}> {
	const directory = existing ?? (await makeDirectory("web-conversations-"));
	if (existing !== undefined) directories.add(existing);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(Subagent);
	registry.install(createForkArchiveGate());
	registry.install(defineExtension({ name: "fork-fixtures", tasks: [Hold, Sleeper] }));
	const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), { models, registry }, TODO_CONTEXT);
	await abortArchivedForks(harness);
	const root = await harness.root(TODO_CONTEXT, {
		agent: {
			cwd: process.cwd(),
			model: { provider: "faux", modelId: "faux-1" },
		},
	});
	const state = replicatedState<ConversationsState>({
		revision: 0,
		selected: String(root.id),
		lane: IDLE_LANE,
		conversations: [],
		tasks: [],
		branchSummarySkipPrompt: false,
		view: null,
	});
	const service = createConversationsService(
		{
			harness,
			root,
			...(branch === undefined
				? {}
				: {
						settings: {
							getBranchSummarySettings: () => ({ reserveTokens: 16384, skipPrompt: branch.skipPrompt === true }),
							getRetrySettings: () => ({ enabled: false, maxRetries: 0, baseDelayMs: 1 }),
						},
						summaryModel: async () => ({
							model: summaryModel,
							...(branch.streamFn === undefined ? {} : { streamFn: branch.streamFn }),
						}),
					}),
		},
		() => state,
	);
	await service.activate(BACKGROUND_CONTEXT);
	return {
		harness,
		directory,
		rootId: String(root.id),
		state,
		service,
		faux,
		async close() {
			service.dispose();
			await harness.close(TODO_CONTEXT);
		},
	};
}

async function askRoot(
	setup: Awaited<ReturnType<typeof openConversations>>,
	text: string,
	responses: readonly FauxResponseStep[],
): Promise<void> {
	setup.faux.setResponses([...responses]);
	const root = (await setup.harness.conversation(Number(setup.rootId) as never, TODO_CONTEXT))!;
	const submission = await root.submit({ type: "input", content: text }, TODO_CONTEXT);
	expect(await submission.wait(TODO_CONTEXT)).toMatchObject({ type: "input", status: "done" });
}

describe("the session's conversation list", () => {
	test("publishes the deadline of a sleeping task", async () => {
		const setup = await openConversations();
		try {
			const root = (await setup.harness.conversation(Number(setup.rootId) as ConversationId, TODO_CONTEXT))!;
			const wakeAt = Date.now() + 60_000;
			const id = await root.commit((tx) => tx.createTask(Sleeper, { at: wakeAt }, { ownership: { kind: "conversation" } }), TODO_CONTEXT);
			setup.harness.resume();
			await waitFor(() => setup.state.value.tasks.some((task) => task.id === String(id) && task.status === "sleeping"), "sleeping task projection");
			expect(setup.state.value.tasks.find((task) => task.id === String(id))).toMatchObject({ wakeAt, phase: "sleep" });
		} finally { await setup.close(); }
	});

	test("shows a parked task after reopen and retries it through the conversation service", async () => {
		let setup = await openConversations();
		try {
			const root = (await setup.harness.conversation(Number(setup.rootId) as ConversationId, TODO_CONTEXT))!;
			const id = await root.commit((tx) => tx.createTask(Hold, {}, { ownership: { kind: "conversation" } }), TODO_CONTEXT);
			const directory = setup.directory;
			await setup.close();
			const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
			try {
				const record = (await storage.task(id, TODO_CONTEXT))!;
				await storage.commit([{ type: "task", value: { ...record, restarts: 5 } }], TODO_CONTEXT);
			} finally { await storage.close(TODO_CONTEXT); }
			setup = await openConversations(directory);
			await waitFor(() => setup.state.value.tasks.some((task) => task.id === String(id) && task.blocked === "restart_limit"), "parked task projection");
			await expect(setup.service.service.retryTask("invalid", TODO_CONTEXT)).rejects.toThrow("Invalid task id");
			await setup.service.service.retryTask(String(id), TODO_CONTEXT);
			await waitFor(() => setup.state.value.tasks.some((task) => task.id === String(id) && task.status === "running" && task.blocked === undefined), "task retry");
			expect((await setup.harness.getTask(id, TODO_CONTEXT))?.restarts).toBeUndefined();
		} finally { await setup.close(); }
	});

	test("reports whether a conversation has an entry to fork from", async () => {
		const setup = await openConversations();
		try {
			await waitFor(() => setup.state.value.conversations.length === 1, "the root in the list");
			expect(setup.state.value.conversations[0]).toMatchObject({ id: setup.rootId, hasEntries: false });
			const root = (await setup.harness.conversation(Number(setup.rootId) as never, TODO_CONTEXT))!;
			await writeUsers(root, "hello");
			await waitFor(() => setup.state.value.conversations[0]?.hasEntries === true, "the entry to fork from");
		} finally {
			await setup.close();
		}
	});

	test("lists the root, then a subagent's child, with its ownership edge", async () => {
		const setup = await openConversations();
		try {
			await waitFor(() => setup.state.value.conversations.length === 1, "the root in the list");
			expect(setup.state.value.conversations[0]).toMatchObject({
				id: setup.rootId,
				label: "main",
				root: true,
			});

			// The live task graph attributes the persistent child to its parent-owned anchor task.
			const owners = new Map<string, string[]>();
			setup.state.subscribe(() => {
				for (const task of setup.state.value.tasks) {
					for (const id of task.conversations) owners.set(id, [...(owners.get(id) ?? []), task.id]);
				}
			});

			await askRoot(setup, "delegate this", [
				fauxAssistantMessage([fauxToolCall("subagent", { action: "run", task: "child task marker" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("the child answered"),
				fauxAssistantMessage("the root answered"),
			]);

			await waitFor(() => setup.state.value.conversations.length === 2, "the child conversation");
			const child = setup.state.value.conversations.find((summary) => !summary.root);
			expect(child).toBeDefined();
			expect(child?.ownerConversationId).toBe(setup.rootId);
			expect(child?.ownerTaskId).toBeDefined();
			// Its label is the first input of its own conversation.
			expect(child?.label).toBe("child task marker");
			// The root owns one child, and the graph attributed that child to a live task.
			expect(setup.state.value.conversations.find((summary) => summary.root)?.children).toBe(1);
			expect(owners.get(child?.id ?? "")?.length ?? 0).toBeGreaterThan(0);
		} finally {
			await setup.close();
		}
	}, 60_000);

	test("focuses a conversation, talks to it, and pages its stored history", async () => {
		const setup = await openConversations();
		try {
			await askRoot(setup, "first input", [fauxAssistantMessage("first answer")]);
			await askRoot(setup, "second input", [fauxAssistantMessage("second answer")]);

			const handle = (await setup.harness.conversation(Number(setup.rootId) as never, TODO_CONTEXT))!;
			// A compaction moves the head; what it replaced is still reachable below the view.
			setup.faux.setResponses([fauxAssistantMessage("a summary of the first inputs")]);
			const controller = createAgentController(setup.harness, () => handle);
			expect(await controller.compact({ customInstructions: null }, BACKGROUND_CONTEXT)).toMatchObject({
				accepted: true,
			});
			await waitFor(() => (setup.state.value.view ?? undefined) === undefined || true, "the compaction to settle");
			const afterCompaction = await (async () => {
				for (let attempt = 0; attempt < 200; attempt++) {
					const page = await handle.entries({}, 1, undefined, TODO_CONTEXT);
					const head = page.items[0];
					if (head !== undefined && head.kind !== "amazme.user") return page;
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				throw new Error("the compaction never committed");
			})();
			const summaryId = afterCompaction.items[0]!.id;
			const replaced = await setup.service.service.older(setup.rootId, String(summaryId), null, 10, BACKGROUND_CONTEXT);
			expect(replaced.entries.length).toBeGreaterThan(0);
			expect(replaced.entries.every((entry) => entry.id < summaryId)).toBe(true);

			// A page bounded by an entry id starts strictly below it.
			const newestPage = await handle.entries({}, 1, undefined, TODO_CONTEXT);
			const newestId = newestPage.items[0]!.id;
			const below = await setup.service.service.older(setup.rootId, String(newestId), null, 5, BACKGROUND_CONTEXT);
			expect(below.entries.length).toBeGreaterThan(0);
			expect(below.entries.every((entry) => entry.id < newestId)).toBe(true);

			// History older than the view: the pages walk back from the oldest entry and stop.
			const first = await setup.service.service.older(setup.rootId, null, null, 2, BACKGROUND_CONTEXT);
			expect(first.entries).toHaveLength(2);
			expect(first.cursor).toBeDefined();
			const second = await setup.service.service.older(setup.rootId, null, first.cursor ?? null, 2, BACKGROUND_CONTEXT);
			expect(second.entries).toHaveLength(2);
			// The pages do not overlap and every entry is older than the previous page's oldest.
			const ids = [...first.entries, ...second.entries].map((entry) => entry.id);
			expect(new Set(ids).size).toBe(ids.length);
			expect(second.entries[second.entries.length - 1]!.id).toBeLessThan(first.entries[0]!.id);
			// Walking past the beginning ends the walk rather than repeating entries.
			const third = await setup.service.service.older(setup.rootId, null, second.cursor ?? null, 8, BACKGROUND_CONTEXT);
			expect(third.entries.every((entry) => entry.id < second.entries[0]!.id)).toBe(true);

			// Focusing the root publishes no separate view; another conversation gets one.
			await setup.service.service.select(setup.rootId, BACKGROUND_CONTEXT);
			expect(setup.state.value.selected).toBe(setup.rootId);
			expect(setup.state.value.view).toBeNull();

			// Talking to a conversation through the service is the same durable submission.
			setup.faux.setResponses([fauxAssistantMessage("answered through the service")]);
			const accepted = await setup.service.service.prompt(setup.rootId, { message: "through the service", images: null }, BACKGROUND_CONTEXT);
			expect(accepted).toMatchObject({ accepted: true });
			const root = (await setup.harness.conversation(Number(setup.rootId) as never, TODO_CONTEXT))!;
			const submitted = async (): Promise<boolean> => {
				const page = await root.entries({}, 10, undefined, TODO_CONTEXT);
				return page.items.some((entry) => (entry.model ?? []).some((message) => JSON.stringify(message.content).includes("through the service")));
			};
			await waitFor(submitted, "the prompt to settle");
			expect(await submitted()).toBe(true);
		} finally {
			await setup.close();
		}
	}, 60_000);

	test("forks the newest entry, focuses the fork, and restores that focus from the same sqlite file", async () => {
		const setup = await openConversations();
		let forkId = "";
		try {
			await askRoot(setup, "first input", [fauxAssistantMessage("first answer")]);
			const created = await setup.service.service.fork(setup.rootId, null, BACKGROUND_CONTEXT);
			expect(created.error).toBeNull();
			expect(created.conversationId).not.toBeNull();
			forkId = created.conversationId ?? "";
			await waitFor(() => setup.state.value.conversations.some((summary) => summary.id === forkId && summary.role === "fork"), "the fork in the list");
			const fork = setup.state.value.conversations.find((summary) => summary.id === forkId);
			expect(fork).toMatchObject({
				role: "fork",
				parentConversationId: setup.rootId,
				depth: 1,
				root: false,
			});
			expect(setup.state.value.selected).toBe(forkId);
			expect(setup.state.value.view).not.toBeNull();
			expect(setup.state.value.lane.role).toBe("fork");
			expect(setup.state.value.lane.model).toBe("faux/faux-1");
			expect(setup.state.value.conversations.find((summary) => summary.root)?.children).toBe(1);
		} finally {
			await setup.close();
		}

		const again = await openConversations(setup.directory);
		try {
			await waitFor(() => again.state.value.selected === forkId, "the stored focus");
			expect(again.state.value.lane.role).toBe("fork");
			expect(again.state.value.conversations.find((summary) => summary.id === forkId)?.parentConversationId).toBe(again.rootId);
		} finally {
			await again.close();
		}
	}, 60_000);
});

async function writeUsers(conversation: Conversation, ...texts: string[]): Promise<EntryRecord[]> {
	const written: EntryRecord[] = [];
	for (const text of texts) {
		written.push(
			await conversation.commit(
				(tx) =>
					tx.appendEntry(UserEntry, conversation.id, {
						model: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
					}),
				TODO_CONTEXT,
			),
		);
	}
	return written;
}

async function entryKinds(conversation: Conversation): Promise<string[]> {
	const kinds: string[] = [];
	let cursor: Parameters<Conversation["entries"]>[2];
	do {
		const page = await conversation.entries({}, 64, cursor, TODO_CONTEXT);
		kinds.push(...page.items.map((entry) => entry.kind));
		cursor = page.next;
	} while (cursor !== undefined);
	return kinds;
}

describe("manual fork management", () => {
	test("stores names and archive stamps across reopen without inheriting them onto another fork", async () => {
		const setup = await openConversations();
		let id = "";
		let siblingId = "";
		try {
			const root = await setup.harness.conversation(parseConversationId(setup.rootId), TODO_CONTEXT);
			if (!root) throw new Error("Missing root");
			await writeUsers(root, "seed");
			id = (await setup.service.service.fork(setup.rootId, null, BACKGROUND_CONTEXT)).conversationId ?? "";
			await setup.service.service.rename(id, "  尝试\n方案 A  ", BACKGROUND_CONTEXT);
			expect(setup.state.value.conversations.find(item => item.id === id)?.label).toBe("尝试 方案 A");
			siblingId = (await setup.service.service.fork(id, null, BACKGROUND_CONTEXT)).conversationId ?? "";
			await setup.service.service.setArchived(id, true, BACKGROUND_CONTEXT);
			const list = await readSummaries(setup.harness, setup.rootId);
			expect(list.find(item => item.id === id)).toMatchObject({ label: "尝试 方案 A", archivedAt: expect.any(Number), readOnly: true, run: "idle", queued: 0 });
			expect(list.find(item => item.id === siblingId)).toMatchObject({ label: "seed" });
			expect(list.find(item => item.id === siblingId)?.readOnly).toBeUndefined();
			const stamp = (await setup.harness.snapshot(ForkManagementDoc, TODO_CONTEXT))?.forks[id]?.archivedAt;
			await setup.service.service.setArchived(id, true, BACKGROUND_CONTEXT);
			expect((await setup.harness.snapshot(ForkManagementDoc, TODO_CONTEXT))?.forks[id]?.archivedAt).toBe(stamp);
		} finally { await setup.close(); }
		const again = await openConversations(setup.directory);
		try {
			expect(again.state.value.conversations.find(item => item.id === id)).toMatchObject({ label: "尝试 方案 A", readOnly: true });
			expect(again.state.value.conversations.find(item => item.id === siblingId)?.archivedAt).toBeUndefined();
			await again.service.service.setArchived(id, false, BACKGROUND_CONTEXT);
			expect(again.state.value.conversations.find(item => item.id === id)).toMatchObject({ label: "尝试 方案 A", queued: 0 });
			expect(again.state.value.conversations.find(item => item.id === id)?.readOnly).toBeUndefined();
		} finally { await again.close(); }
	});

	test("archives only its ownership scope, including background work and queued input, not history descendants", async () => {
		const setup = await openConversations();
		try {
			const root = await setup.harness.conversation(parseConversationId(setup.rootId), TODO_CONTEXT);
			if (!root) throw new Error("Missing root");
			await writeUsers(root, "seed");
			const id = (await setup.service.service.fork(setup.rootId, null, BACKGROUND_CONTEXT)).conversationId ?? "";
			const other = (await setup.service.service.fork(id, null, BACKGROUND_CONTEXT)).conversationId ?? "";
			const fork = await setup.harness.conversation(parseConversationId(id), TODO_CONTEXT);
			if (!fork) throw new Error("Missing fork");
			const rootPending = pendingResponse();
			const forkPending = pendingResponse();
			const otherPending = pendingResponse();
			const childPending = pendingResponse();
			setup.faux.setResponses([rootPending.step, forkPending.step, otherPending.step, childPending.step]);
			await setup.service.service.prompt(setup.rootId, { message: "root live", images: null }, BACKGROUND_CONTEXT);
			await rootPending.reached;
			await setup.service.service.prompt(id, { message: "fork live", images: null }, BACKGROUND_CONTEXT);
			await forkPending.reached;
			await setup.service.service.prompt(other, { message: "other live", images: null }, BACKGROUND_CONTEXT);
			await otherPending.reached;
			const owned = await fork.commit(async tx => {
				const task = await tx.createTask(Hold, {}, { ownership: { kind: "conversation" }, background: true });
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: task } });
				return { task, child: child.id };
			}, TODO_CONTEXT);
			const childId = String(owned.child);
			await (await setup.harness.conversation(owned.child, TODO_CONTEXT))?.configure({ extensions: { remove: [createForkArchiveGate()] } }, TODO_CONTEXT);
			await setup.service.service.prompt(childId, { message: "owned child live", images: null }, BACKGROUND_CONTEXT);
			await childPending.reached;
			const child = await setup.harness.conversation(owned.child, TODO_CONTEXT);
			const independent = await setup.harness.conversation(parseConversationId(other), TODO_CONTEXT);
			if (!child || !independent) throw new Error("Missing test conversation");
			const childWrite = await child.submit({ type: "write", entry: { kind: "test.child-write", model: [{ role: "user", content: "owned pending write", timestamp: 1 }] } }, TODO_CONTEXT);
			const independentWrite = await independent.submit({ type: "write", entry: { kind: "test.independent-write", model: [{ role: "user", content: "independent pending write", timestamp: 1 }] } }, TODO_CONTEXT);
			const queuedWrite = await fork.submit({ type: "write", entry: { kind: "test.queued-summary", model: [{ role: "user", content: "must not place this old summary", timestamp: 1 }] } }, TODO_CONTEXT);
			expect((await queuedWrite.status(TODO_CONTEXT)).status).toBe("queued");
			const queued = await setup.service.service.followUp(id, { message: "cancel this queue", images: null }, BACKGROUND_CONTEXT);
			const childQueue = await setup.service.service.followUp(childId, { message: "cancel child queue", images: null }, BACKGROUND_CONTEXT);
			expect(queued.accepted && childQueue.accepted).toBe(true);
			await setup.service.service.refresh(BACKGROUND_CONTEXT);
			expect(setup.state.value.conversations.find(item => item.id === id)).toMatchObject({ run: "working", queued: 1 });
			await setup.service.service.setArchived(id, true, BACKGROUND_CONTEXT);
			expect((await setup.harness.getTask(owned.task, TODO_CONTEXT))?.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
			await expect(setup.service.service.retryTask(String(owned.task), TODO_CONTEXT)).rejects.toThrow("分叉已归档");
			expect(await setup.harness.snapshot(InboxDoc, fork.id, TODO_CONTEXT)).toMatchObject({ items: [] });
			expect((await queuedWrite.wait(TODO_CONTEXT)).status).toBe("unanswered");
			expect((await childWrite.wait(TODO_CONTEXT)).status).toBe("unanswered");
			expect((await independentWrite.status(TODO_CONTEXT)).status).toBe("queued");
			expect((await entryKinds(fork)).includes("test.queued-summary")).toBe(false);
			expect(await setup.harness.snapshot(InboxDoc, owned.child, TODO_CONTEXT)).toMatchObject({ items: [] });
			expect(setup.state.value.conversations.find(item => item.id === childId)?.readOnly).toBe(true);
			expect((await setup.harness.snapshot(AgentDoc, owned.child, TODO_CONTEXT))?.extensions).toMatchObject({ add: ["archived-fork-gate"], remove: [] });
			expect((await setup.harness.snapshot(LiveDoc, root.id, TODO_CONTEXT))?.run).toBeDefined();
			expect((await setup.harness.snapshot(LiveDoc, parseConversationId(other), TODO_CONTEXT))?.run).toBeDefined();
			expect(setup.state.value.conversations.find(item => item.id === other)?.readOnly).toBeUndefined();
			for (const submission of [queued.accepted ? queued.entryId : "", childQueue.accepted ? childQueue.entryId : ""]) {
				expect((await (await setup.harness.submission(Number(submission) as never, TODO_CONTEXT))?.status(TODO_CONTEXT))?.status).toBe("unanswered");
			}
			await setup.service.service.setArchived(id, false, BACKGROUND_CONTEXT);
			expect((await setup.harness.snapshot(LiveDoc, fork.id, TODO_CONTEXT))?.run).toBeUndefined();
			expect((await setup.harness.snapshot(InboxDoc, fork.id, TODO_CONTEXT))?.items).toEqual([]);
		} finally { await setup.close(); }
	});

	test("recovery clears queued work if shutdown happened after the archive stamp but before cancellation", async () => {
		const setup = await openConversations();
		let id = "";
		try {
			const root = await setup.harness.conversation(parseConversationId(setup.rootId), TODO_CONTEXT);
			if (!root) throw new Error("Missing root");
			await writeUsers(root, "seed");
			id = (await setup.service.service.fork(setup.rootId, null, BACKGROUND_CONTEXT)).conversationId ?? "";
			const pending = pendingResponse();
			setup.faux.setResponses([pending.step]);
			await setup.service.service.prompt(id, { message: "interrupted", images: null }, BACKGROUND_CONTEXT);
			await pending.reached;
			await setup.service.service.followUp(id, { message: "must not replay", images: null }, BACKGROUND_CONTEXT);
			const fork = await setup.harness.conversation(parseConversationId(id), TODO_CONTEXT);
			await fork?.submit({ type: "write", entry: { kind: "test.queued-recovery", model: [{ role: "user", content: "old write", timestamp: 1 }] } }, TODO_CONTEXT);
			await setup.harness.commit(async tx => {
				const doc = await tx.doc(ForkManagementDoc);
				doc.forks[id] = { archivedAt: 1 };
			}, TODO_CONTEXT);
		} finally { await setup.close(); }
		const again = await openConversations(setup.directory);
		try {
			expect((await again.harness.snapshot(InboxDoc, parseConversationId(id), TODO_CONTEXT))?.items).toEqual([]);
			expect((await again.harness.snapshot(LiveDoc, parseConversationId(id), TODO_CONTEXT))?.run).toBeUndefined();
			expect(again.faux.state.callCount).toBe(0);
			const fork = await again.harness.conversation(parseConversationId(id), TODO_CONTEXT);
			if (!fork) throw new Error("Missing recovered fork");
			expect((await entryKinds(fork)).includes("test.queued-recovery")).toBe(false);
			await again.service.service.setArchived(id, false, BACKGROUND_CONTEXT);
			expect(again.faux.state.callCount).toBe(0);
		} finally { await again.close(); }
	});

	test("fences late queued input against archive admission and restoration never replays it", async () => {
		const setup = await openConversations();
		try {
			const root = await setup.harness.conversation(parseConversationId(setup.rootId), TODO_CONTEXT);
			if (!root) throw new Error("Missing root");
			await writeUsers(root, "seed");
			const id = (await setup.service.service.fork(setup.rootId, null, BACKGROUND_CONTEXT)).conversationId ?? "";
			const fork = await setup.harness.conversation(parseConversationId(id), TODO_CONTEXT);
			if (!fork) throw new Error("Missing fork");
			const pending = pendingResponse();
			setup.faux.setResponses([pending.step]);
			await setup.service.service.prompt(id, { message: "live", images: null }, BACKGROUND_CONTEXT);
			await pending.reached;
			let release = () => {};
			let reached = () => {};
			const gate = new Promise<void>(resolve => { release = resolve; });
			const entering = new Promise<void>(resolve => { reached = resolve; });
			const controller = createAgentController(setup.harness, () => fork, async () => { reached(); await gate; return undefined; });
			const late = controller.followUp({ message: "late queue", images: null }, BACKGROUND_CONTEXT);
			await entering;
			const archive = setup.service.service.setArchived(id, true, BACKGROUND_CONTEXT);
			release();
			const [accepted] = await Promise.all([late, archive]);
			expect(accepted.accepted).toBe(true);
			expect((await setup.harness.snapshot(InboxDoc, fork.id, TODO_CONTEXT))?.items).toEqual([]);
			await setup.service.service.setArchived(id, false, BACKGROUND_CONTEXT);
			expect((await setup.harness.snapshot(LiveDoc, fork.id, TODO_CONTEXT))?.run).toBeUndefined();
			setup.faux.setResponses([fauxAssistantMessage("new work")]);
			const fresh = await setup.service.service.prompt(id, { message: "explicit new work", images: null }, BACKGROUND_CONTEXT);
			expect(fresh.accepted).toBe(true);
			if (!fresh.accepted) throw new Error("Prompt refused");
			expect((await (await setup.harness.submission(Number(fresh.operationId) as never, TODO_CONTEXT))?.wait(TODO_CONTEXT))?.status).toBe("done");
		} finally { await setup.close(); }
	});

	test("rejects root, subagent and invalid metadata operations, and blocks every archived work entry", async () => {
		const setup = await openConversations();
		try {
			const root = await setup.harness.conversation(parseConversationId(setup.rootId), TODO_CONTEXT);
			if (!root) throw new Error("Missing root");
			await writeUsers(root, "seed", "next");
			const id = (await setup.service.service.fork(setup.rootId, null, BACKGROUND_CONTEXT)).conversationId ?? "";
			const owned = await root.commit(async tx => {
				const task = await tx.createTask(Hold, {}, { ownership: { kind: "conversation" }, background: true });
				return (await tx.createConversation({ ownership: { kind: "task", taskId: task } })).id;
			}, TODO_CONTEXT);
			for (const invalid of [setup.rootId, String(owned)]) {
				await expect(setup.service.service.rename(invalid, "no", BACKGROUND_CONTEXT)).rejects.toThrow("只能管理人工分叉");
				await expect(setup.service.service.setArchived(invalid, true, BACKGROUND_CONTEXT)).rejects.toThrow("只能管理人工分叉");
			}
			await expect(setup.service.service.rename(id, " ", BACKGROUND_CONTEXT)).rejects.toThrow("1–200");
			await expect(setup.service.service.rename(id, "x".repeat(201), BACKGROUND_CONTEXT)).rejects.toThrow("1–200");
			await expect(setup.service.service.setArchived("NaN", true, BACKGROUND_CONTEXT)).rejects.toThrow("无效");
			await (await setup.harness.conversation(parseConversationId(id), TODO_CONTEXT))?.configure({ extensions: [] }, TODO_CONTEXT);
			await setup.service.service.setArchived(id, true, BACKGROUND_CONTEXT);
			await expect(setup.service.service.rename(id, "archived rename", BACKGROUND_CONTEXT)).rejects.toThrow("分叉已归档");
			expect((await setup.harness.snapshot(AgentDoc, parseConversationId(id), TODO_CONTEXT))?.extensions).toEqual(["archived-fork-gate"]);
			for (const call of ["prompt", "steer", "followUp"] as const) {
				expect(await setup.service.service[call](id, { message: "blocked", images: null }, BACKGROUND_CONTEXT)).toMatchObject({ accepted: false, error: { code: "conversation_archived" } });
			}
			expect(await setup.service.service.compact(id, { customInstructions: null }, BACKGROUND_CONTEXT)).toMatchObject({ accepted: false, error: { code: "conversation_archived" } });
			expect((await setup.service.service.fork(id, null, BACKGROUND_CONTEXT)).error).not.toBeNull();
			const points = await setup.service.service.returnPoints(id, BACKGROUND_CONTEXT);
			const at = points[0]?.id;
			if (!at) throw new Error("Missing return point");
			expect((await setup.service.service.leave(id, at, { summarize: false }, BACKGROUND_CONTEXT)).error).not.toBeNull();
			const controller = createAgentController(setup.harness, () => root);
			expect(await controller.prompt({ conversationId: id, message: "bypass attempt", images: null }, BACKGROUND_CONTEXT)).toMatchObject({ accepted: false, error: { code: "conversation_archived" } });
			setup.faux.setResponses([fauxAssistantMessage("should not reach provider")]);
			const archived = await setup.harness.conversation(parseConversationId(id), TODO_CONTEXT);
			if (!archived) throw new Error("Missing fork");
			const direct = await archived.submit({ type: "input", content: "raw harness attempt" }, TODO_CONTEXT);
			expect((await direct.wait(TODO_CONTEXT)).status).toBe("unanswered");
			expect(setup.faux.state.callCount).toBe(0);
			await setup.service.service.select(id, BACKGROUND_CONTEXT);
			expect(setup.state.value.selected).toBe(id);
			expect(setup.state.value.view?.entries.length).toBeGreaterThan(0);
		} finally { await setup.close(); }
	});
});

describe("tree navigation on the session surface", () => {
	test("uses a placed application input for conversation labels and return points", async () => {
		const setup = await openConversations();
		try {
			const child = await setup.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, TODO_CONTEXT);
			const input = await child.submit({ type: "input", content: "ann: check the build", entry: { kind: "chat.mention", data: { author: "ann" } } }, TODO_CONTEXT);
			await input.wait(TODO_CONTEXT);
			const summary = (await readSummaries(setup.harness, setup.rootId)).find((item) => item.id === String(child.id));
			expect(summary?.label).toBe("ann: check the build");
			expect((await readReturnPoints(child, TODO_CONTEXT)).map((point) => point.label)).toEqual(["ann: check the build"]);
		} finally {
			await setup.close();
		}
	});

	test("focuses an existing conversation without a summary or a new conversation", async () => {
		const setup = await openConversations();
		try {
			const root = (await setup.harness.conversation(Number(setup.rootId) as never, TODO_CONTEXT))!;
			await writeUsers(root, "u1", "u2");
			const created = await setup.service.service.fork(setup.rootId, null, BACKGROUND_CONTEXT);
			expect(created.error).toBeNull();
			const siblingId = created.conversationId ?? "";
			const before = await readSummaries(setup.harness, setup.rootId);

			const focused = await navigateTree(setup.harness, { kind: "focus", conversationId: siblingId }, TODO_CONTEXT);
			expect(String(focused.conversation.id)).toBe(siblingId);
			expect(focused.created).toBe(false);
			expect(focused.summarized).toBe(false);

			await setup.service.service.select(setup.rootId, BACKGROUND_CONTEXT);
			const after = await readSummaries(setup.harness, setup.rootId);
			expect(after.map((summary) => summary.id)).toEqual(before.map((summary) => summary.id));
			expect(setup.state.value.selected).toBe(setup.rootId);
			expect(await entryKinds(root)).not.toContain("amazme.branch-summary");
			const sibling = (await setup.harness.conversation(Number(siblingId) as never, TODO_CONTEXT))!;
			expect(await entryKinds(sibling)).not.toContain("amazme.branch-summary");
		} finally {
			await setup.close();
		}
	});

	test("leaves with a summary on the continuation branchSummary returns, and focuses that continuation", async () => {
		let summarized = false;
		const setup = await openConversations(undefined, {
			streamFn: (model, context, options) => {
				summarized = true;
				return summaryStream("LEFT THE BRANCH")(model, context, options);
			},
		});
		try {
			const root = (await setup.harness.conversation(Number(setup.rootId) as never, TODO_CONTEXT))!;
			const [first] = await writeUsers(root, "keep", "abandoned tail");
			const sibling = await setup.service.service.fork(setup.rootId, null, BACKGROUND_CONTEXT);
			expect(sibling.error).toBeNull();
			const siblingId = sibling.conversationId ?? "";
			await setup.service.service.select(setup.rootId, BACKGROUND_CONTEXT);

			const left = await setup.service.service.leave(setup.rootId, String(first!.id), { summarize: true, customInstructions: null }, BACKGROUND_CONTEXT);
			expect(left.error).toBeNull();
			expect(left.cancelled).toBe(false);
			expect(left.summarized).toBe(true);
			expect(summarized).toBe(true);
			expect(left.conversationId).not.toBe(setup.rootId);
			expect(left.conversationId).not.toBe(siblingId);
			expect(setup.state.value.selected).toBe(left.conversationId);

			const continued = (await setup.harness.conversation(Number(left.conversationId) as never, TODO_CONTEXT))!;
			const page = await continued.entries({}, 10, undefined, TODO_CONTEXT);
			const summary = page.items.find((entry) => entry.kind === "amazme.branch-summary");
			expect(BranchSummaryEntry.is(summary)).toBe(true);
			if (!BranchSummaryEntry.is(summary)) throw new Error("unreachable");
			expect(summary.data.summary).toContain("LEFT THE BRANCH");
			expect(summary.conversationId).toBe(continued.id);
			expect(await entryKinds(root)).not.toContain("amazme.branch-summary");
			const siblingConversation = (await setup.harness.conversation(Number(siblingId) as never, TODO_CONTEXT))!;
			expect(await entryKinds(siblingConversation)).not.toContain("amazme.branch-summary");
		} finally {
			await setup.close();
		}
	});

	test("a branch summary already in the tail keeps its body and file lists for the next summary", async () => {
		let prompt = "";
		const setup = await openConversations(undefined, {
			streamFn: (model, context, options) => {
				prompt = JSON.stringify(context);
				return summaryStream("NEXT")(model, context, options);
			},
		});
		try {
			const root = (await setup.harness.conversation(Number(setup.rootId) as never, TODO_CONTEXT))!;
			const [first] = await writeUsers(root, "keep");
			await root.commit(
				(tx) =>
					tx.appendEntry(BranchSummaryEntry, root.id, {
						model: [{ role: "user", content: [{ type: "text", text: "WRAPPED ONLY" }], timestamp: 1 }],
						data: {
							summary: "PRIOR SUMMARY",
							from: { conversationId: root.id, entryId: first!.id },
							details: { readFiles: ["src/kept.ts"], modifiedFiles: ["src/edited.ts"] },
						},
					}),
				TODO_CONTEXT,
			);
			await writeUsers(root, "later tail");
			const points = await readReturnPoints(root, TODO_CONTEXT);
			expect(points.map((point) => point.label)).toEqual(["keep"]);

			const left = await setup.service.service.leave(setup.rootId, String(first!.id), { summarize: true, customInstructions: null }, BACKGROUND_CONTEXT);
			expect(left.error).toBeNull();
			expect(left.summarized).toBe(true);
			expect(prompt).toContain("PRIOR SUMMARY");
			expect(prompt).toContain("later tail");
			expect(prompt).not.toContain("WRAPPED ONLY");

			const continued = (await setup.harness.conversation(Number(left.conversationId) as never, TODO_CONTEXT))!;
			const page = await continued.entries({}, 10, undefined, TODO_CONTEXT);
			const summary = page.items.find((entry) => entry.kind === "amazme.branch-summary");
			expect(BranchSummaryEntry.is(summary)).toBe(true);
			if (!BranchSummaryEntry.is(summary)) throw new Error("unreachable");
			expect(summary.data.summary).toContain("NEXT");
			expect(summary.data.summary).toContain("src/kept.ts");
			expect(summary.data.summary).toContain("src/edited.ts");
		} finally {
			await setup.close();
		}
	});

	test("skipPrompt leaves without asking the summarizer and without a branch-summary entry", async () => {
		const setup = await openConversations(undefined, {
			skipPrompt: true,
			streamFn: () => {
				throw new Error("summarizer should not run");
			},
		});
		try {
			const root = (await setup.harness.conversation(Number(setup.rootId) as never, TODO_CONTEXT))!;
			const [first] = await writeUsers(root, "keep", "tail");
			const before = (await readSummaries(setup.harness, setup.rootId)).length;
			const left = await setup.service.service.leave(setup.rootId, String(first!.id), { summarize: true, customInstructions: null }, BACKGROUND_CONTEXT);
			expect(left.error).toBeNull();
			expect(left.summarized).toBe(false);
			expect(left.conversationId).not.toBe(setup.rootId);
			expect(setup.state.value.selected).toBe(left.conversationId);
			expect((await readSummaries(setup.harness, setup.rootId)).length).toBe(before + 1);
			const continued = (await setup.harness.conversation(Number(left.conversationId) as never, TODO_CONTEXT))!;
			expect(await entryKinds(continued)).not.toContain("amazme.branch-summary");
			expect(await entryKinds(root)).not.toContain("amazme.branch-summary");
		} finally {
			await setup.close();
		}
	});
});

describe("durable foreground subagents", () => {
	const context = BACKGROUND_CONTEXT;
	const delegate = (task: string, conversationId?: string) => fauxAssistantMessage([
		fauxToolCall("subagent", { action: "run", task, ...(conversationId === undefined ? {} : { conversationId }) }),
	], { stopReason: "toolUse" });
	const parentAnswer: FauxResponseStep = request => {
		const result = request.messages.findLast(message => message.role === "toolResult");
		if (result?.role !== "toolResult") throw new Error("Parent received no tool result");
		return fauxAssistantMessage(result.content.flatMap(part => part.type === "text" ? [part.text] : []).join(""));
	};
	const childId = async (setup: Awaited<ReturnType<typeof openConversations>>): Promise<ConversationId> => {
		const page = await setup.harness.commit(tx => tx.scanConversations({ ownerConversationId: parseConversationId(setup.rootId) }, 50), context);
		const child = page.items[0];
		if (child === undefined) throw new Error("Child was not created");
		return child.id;
	};
	const rootOf = async (setup: Awaited<ReturnType<typeof openConversations>>) => {
		const root = await setup.harness.conversation(parseConversationId(setup.rootId), context);
		if (root === undefined) throw new Error("Root is unavailable");
		return root;
	};

	test("delivers child text and ID to the parent model, lists and continues the same history", async () => {
		const setup = await openConversations();
		try {
			await askRoot(setup, "delegate", [request => {
				const tool = getCurrentTools(request.messages).find(tool => tool.name === "subagent");
				if (tool === undefined) throw new Error("Subagent tool was not declared");
				expect(makeStrictJsonSchema(tool.parameters)).toMatchObject({ type: "object", properties: { action: { type: "string", enum: ["run", "list"] } } });
				return delegate("remember alpha");
			}, fauxAssistantMessage("alpha answer"), request => {
				const result = request.messages.findLast(message => message.role === "toolResult");
				expect(result?.content).toEqual([{ type: "text", text: expect.stringMatching(/^Subagent \d+\nalpha answer$/) }]);
				return fauxAssistantMessage("parent received alpha");
			}]);
			const id = await childId(setup);
			await askRoot(setup, "continue", [delegate("remember beta", String(id)), request => {
				const messages = JSON.stringify(request.messages);
				expect(messages).toContain("remember alpha");
				expect(messages).toContain("alpha answer");
				expect(messages).toContain("remember beta");
				expect(getCurrentTools(request.messages).some(tool => tool.name === "subagent")).toBe(false);
				return fauxAssistantMessage("beta answer");
			}, request => {
				const result = request.messages.findLast(message => message.role === "toolResult");
				expect(result?.content).toEqual([{ type: "text", text: `Subagent ${id}\nbeta answer` }]);
				return fauxAssistantMessage("parent received beta");
			}]);
			await askRoot(setup, "list", [fauxAssistantMessage([fauxToolCall("subagent", { action: "list" })], { stopReason: "toolUse" }), request => {
				const result = request.messages.findLast(message => message.role === "toolResult");
				expect(result?.content).toEqual([{ type: "text", text: `${id}: idle | remember alpha` }]);
				return fauxAssistantMessage("listed");
			}]);
			expect((await setup.harness.commit(tx => tx.scanConversations({}, 50), context)).items).toHaveLength(2);
		} finally { await setup.close(); }
	});

	test("rejects foreign and unrelated children before submitting and does not list them", async () => {
		const setup = await openConversations();
		try {
			const other = await setup.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
			const foreign = await other.commit(async tx => {
				const creator = await tx.createTask(Hold, {}, { ownership: { kind: "conversation" } });
				const owner = await tx.createTask(SubagentOwner, { creator }, { ownership: { kind: "conversation" } });
				return (await tx.createConversation({ ownership: { kind: "task", taskId: owner } })).id;
			}, context);
			const unrelated = await (await rootOf(setup)).commit(async tx => {
				const owner = await tx.createTask(Hold, {}, { ownership: { kind: "conversation" } });
				return (await tx.createConversation({ ownership: { kind: "task", taskId: owner } })).id;
			}, context);
			for (const id of [foreign, unrelated, parseConversationId(setup.rootId)]) {
				await askRoot(setup, "invalid delegation", [delegate("must not reach a child", String(id)), request => {
					const result = request.messages.findLast(message => message.role === "toolResult");
					expect(result).toMatchObject({ isError: true });
					expect(JSON.stringify(result)).toContain("does not belong");
					return fauxAssistantMessage("refused");
				}]);
			}
			await askRoot(setup, "list", [fauxAssistantMessage([fauxToolCall("subagent", { action: "list" })], { stopReason: "toolUse" }), request => {
				const result = request.messages.findLast(message => message.role === "toolResult");
				expect(result?.content).toEqual([{ type: "text", text: "No subagents." }]);
				return fauxAssistantMessage("no children");
			}]);
			for (const id of [foreign, unrelated]) expect((await setup.harness.commit(tx => tx.scanSubmissions({ conversationId: id }, 10), context)).items).toHaveLength(0);
		} finally { await setup.close(); }
	});

	test("rejects continuation of a busy child without a new child or input", async () => {
		const setup = await openConversations();
		try {
			await askRoot(setup, "first", [delegate("first task"), fauxAssistantMessage("first answer"), parentAnswer]);
			const id = await childId(setup);
			const pending = pendingResponse();
			setup.faux.setResponses([pending.step]);
			await (await setup.harness.conversation(id, context))!.submit({ type: "input", content: "busy human input" }, context);
			await pending.reached;
			const before = (await setup.harness.commit(tx => tx.scanSubmissions({ conversationId: id }, 50), context)).items;
			await askRoot(setup, "continue busy", [delegate("must not be queued", String(id)), request => {
				const result = request.messages.findLast(message => message.role === "toolResult");
				expect(result).toMatchObject({ isError: true });
				expect(JSON.stringify(result)).toContain("is busy");
				return fauxAssistantMessage("busy refusal observed");
			}]);
			expect((await setup.harness.commit(tx => tx.scanSubmissions({ conversationId: id }, 50), context)).items).toEqual(before);
			expect((await setup.harness.commit(tx => tx.scanConversations({}, 50), context)).items).toHaveLength(2);
		} finally { await setup.close(); }
	});

	test("lists bounded pages without losing a child at the cursor", async () => {
		const setup = await openConversations();
		try {
			const root = await rootOf(setup);
			const children = await root.commit(async tx => {
				const creator = await tx.createTask(Hold, {}, { ownership: { kind: "conversation" } });
				const result: ConversationId[] = [];
				for (let index = 0; index < 51; index++) {
					const owner = await tx.createTask(SubagentOwner, { creator }, { ownership: { kind: "conversation" } });
					result.push((await tx.createConversation({ ownership: { kind: "task", taskId: owner } })).id);
				}
				return result.reverse();
			}, context);
			await askRoot(setup, "first page", [fauxAssistantMessage([fauxToolCall("subagent", { action: "list" })], { stopReason: "toolUse" }), request => {
				const result = request.messages.findLast(message => message.role === "toolResult");
				expect(result?.content).toEqual([{ type: "text", text: `${children.slice(0, 50).map(id => `${id}: idle | task unavailable`).join("\n")}\nMore subagents: list with beforeConversationId "${children[49]}".` }]);
				return fauxAssistantMessage("first page received");
			}]);
			await askRoot(setup, "second page", [fauxAssistantMessage([fauxToolCall("subagent", { action: "list", beforeConversationId: String(children[49]) })], { stopReason: "toolUse" }), request => {
				const result = request.messages.findLast(message => message.role === "toolResult");
				expect(result?.content).toEqual([{ type: "text", text: `${children[50]}: idle | task unavailable` }]);
				return fauxAssistantMessage("last page received");
			}]);
		} finally { await setup.close(); }
	});

	for (const continuation of [false, true]) test(`cancels only the ${continuation ? "continued" : "first"} input and preserves a later human input`, async () => {
		const setup = await openConversations();
		try {
			if (continuation) await askRoot(setup, "first", [delegate("first task"), fauxAssistantMessage("first answer"), parentAnswer]);
			const selected = continuation ? String(await childId(setup)) : undefined;
			const pending = pendingResponse();
			setup.faux.setResponses([delegate("held child task", selected), pending.step]);
			const root = await rootOf(setup);
			const parent = await root.submit({ type: "input", content: "delegate held task" }, context);
			await pending.reached;
			const id = await childId(setup);
			const child = (await setup.harness.conversation(id, context))!;
			const later = await child.submit({ type: "input", content: "later human input", whenBusy: "followUp" }, context);
			const finish: FauxResponseStep = request => JSON.stringify(request.messages.at(-1)).includes("later human input")
				? fauxAssistantMessage("human input survived") : fauxAssistantMessage("parent cancellation observed");
			setup.faux.setResponses([finish, finish, finish]);
			const tool = (await setup.harness.snapshot(LiveDoc, root.id, context))?.tools?.find(item => item.name === "subagent");
			if (tool?.taskId === undefined) throw new Error("Delegation tool is not running");
			await setup.harness.abortTask(tool.taskId, context);
			expect((await later.wait(context)).status).toBe("done");
			expect((await parent.wait(context)).status).toBe("done");
			await setup.harness.waitForIdle(context);
			const inputs = (await setup.harness.commit(tx => tx.scanSubmissions({ conversationId: id }, 50), context)).items;
			expect(inputs.find(input => input.requestId === `subagent:${tool.taskId}`)).toMatchObject({ status: "unanswered", reason: "aborted" });
			expect(inputs.find(input => input.id === later.id)).toMatchObject({ status: "done" });
		} finally { await setup.close(); }
	});

	test("reopens pending delegation without another child or duplicate input", async () => {
		const first = await openConversations();
		const pending = pendingResponse();
		first.faux.setResponses([delegate("persisted child task"), pending.step]);
		const parent = await (await rootOf(first)).submit({ type: "input", content: "delegate" }, context);
		await pending.reached;
		const id = await childId(first);
		const before = await first.harness.commit(tx => tx.scanSubmissions({ conversationId: id }, 50), context);
		await first.close();
		const restored = await openConversations(first.directory);
		try {
			restored.faux.setResponses([fauxAssistantMessage("resumed child answer"), parentAnswer]);
			const resumed = await restored.harness.submission(parent.id, context);
			expect((await resumed!.wait(context)).status).toBe("done");
			await restored.harness.waitForIdle(context);
			expect(await childId(restored)).toBe(id);
			expect((await restored.harness.commit(tx => tx.scanConversations({}, 50), context)).items).toHaveLength(2);
			expect((await restored.harness.commit(tx => tx.scanSubmissions({ conversationId: id }, 50), context)).items.map(input => input.id)).toEqual(before.items.map(input => input.id));
			const entries = await (await rootOf(restored)).entries({}, 50, undefined, context);
			expect(JSON.stringify(entries.items)).toContain(`Subagent ${id}\\nresumed child answer`);
		} finally { await restored.close(); }
	});

	test("aborting a supervisor before submission does not admit an input", async () => {
		const setup = await openConversations();
		try {
			const child = await setup.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
			const supervisor = await (await rootOf(setup)).commit(tx => tx.createTask(SubagentRun,
				{ conversationId: child.id, requestId: "never-admitted", task: "must not run" }, { ownership: { kind: "conversation" } }), context);
			await setup.harness.abortTask(supervisor, context);
			expect((await setup.harness.waitForTask(supervisor, context)).state.outcome.status).toBe("aborted");
			expect((await setup.harness.commit(tx => tx.scanSubmissions({ conversationId: child.id }, 10), context)).items).toHaveLength(0);
			expect((await child.entries({}, 10, undefined, context)).items).toHaveLength(0);
		} finally { await setup.close(); }
	});

	test("an aborted supervisor recovers an admitted input by request ID without submitting again", async () => {
		const first = await openConversations();
		const pending = pendingResponse();
		first.faux.setResponses([pending.step]);
		const child = await first.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
		const original = await child.submit({ type: "input", content: "admitted before checkpoint", requestId: "gap-input" }, context);
		await pending.reached;
		await first.close();
		const restored = await openConversations(first.directory);
		try {
			restored.faux.setResponses([pendingResponse().step]);
			const supervisor = await (await rootOf(restored)).commit(tx => tx.createTask(SubagentRun,
				{ conversationId: child.id, requestId: "gap-input", task: "must not duplicate" }, { ownership: { kind: "conversation" } }), context);
			await restored.harness.abortTask(supervisor, context);
			expect((await restored.harness.waitForTask(supervisor, context)).state.outcome.status).toBe("aborted");
			const inputs = (await restored.harness.commit(tx => tx.scanSubmissions({ conversationId: child.id }, 10), context)).items;
			expect(inputs).toHaveLength(1);
			expect(inputs[0]).toMatchObject({ id: original.id, status: "unanswered", reason: "aborted" });
		} finally { await restored.close(); }
	});
});
