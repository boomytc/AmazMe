import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@amazme/agent";
import { createAssistantMessageEventStream, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type Model } from "@amazme/ai";
import { replicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT, TODO_CONTEXT } from "@amazme/chord/context";
import { BranchSummaryEntry, createRegistry, Harness, type Conversation, type EntryRecord, UserEntry } from "@amazme/durable";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";
import { afterEach, describe, expect, test } from "vitest";
import { Subagent } from "../src/durable/subagent.ts";
import { createAgentController } from "../src/experimental/services/agent-controller-provider.ts";
import { type ConversationsState, IDLE_LANE } from "../src/durable/conversation-view.ts";
import { createConversationsService } from "../src/experimental/services/conversations-provider.ts";
import { navigateTree, readReturnPoints, readSummaries } from "../src/durable/session-surface.ts";

/**
 * The conversation list, the live task graph, and stored history, over a real Harness driven by the
 * faux provider. A subagent call needs a model to decide on it, so this is the level that can drive
 * one: the scripted assistant asks for the `subagent` tool, and the child conversation it creates is
 * what the list and the task graph must report.
 */
const directories = new Set<string>();

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
	const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), { models, registry }, TODO_CONTEXT);
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
	responses: readonly ReturnType<typeof fauxAssistantMessage>[],
): Promise<void> {
	setup.faux.setResponses([...responses]);
	const root = (await setup.harness.conversation(Number(setup.rootId) as never, TODO_CONTEXT))!;
	const submission = await root.submit({ type: "input", content: text }, TODO_CONTEXT);
	await submission.wait(TODO_CONTEXT);
}

describe("the session's conversation list", () => {
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

			// The live task graph while the call runs: the child belongs to the tool task that made it.
			const owners = new Map<string, string[]>();
			setup.state.subscribe(() => {
				for (const task of setup.state.value.tasks) {
					for (const id of task.conversations) owners.set(id, [...(owners.get(id) ?? []), task.id]);
				}
			});

			await askRoot(setup, "delegate this", [
				fauxAssistantMessage([fauxToolCall("subagent", { task: "child task marker" })], {
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
			const controller = createAgentController(setup.harness, handle);
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

describe("tree navigation on the session surface", () => {
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
