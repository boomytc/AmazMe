import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@amazme/ai";
import { createModels } from "@amazme/ai";
import { replicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT, TODO_CONTEXT } from "@amazme/chord/context";
import { createRegistry, Harness } from "@amazme/durable";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";
import { afterEach, describe, expect, test } from "vitest";
import { createConversationsService } from "../src/experimental/services/conversations-provider.ts";
import type { ConversationsState } from "../src/experimental/services/conversations.ts";
import { Subagent } from "../src/experimental/durable/subagent.ts";

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

/** A harness with the subagent tool and a scripted provider, and the conversations service on top. */
async function openConversations(): Promise<{
	readonly harness: Harness;
	readonly rootId: string;
	readonly state: ReturnType<typeof replicatedState<ConversationsState>>;
	readonly service: ReturnType<typeof createConversationsService>;
	readonly faux: ReturnType<typeof fauxProvider>;
	close(): Promise<void>;
}> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(Subagent);
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(await makeDirectory("web-conversations-"), "session.sqlite")),
		{ models, registry },
		TODO_CONTEXT,
	);
	const root = await harness.root(TODO_CONTEXT, {
		agent: { cwd: process.cwd(), model: { provider: "faux", modelId: "faux-1" } },
	});
	const state = replicatedState<ConversationsState>({
		revision: 0,
		selected: String(root.id),
		conversations: [],
		tasks: [],
		view: null,
	});
	const service = createConversationsService({ harness, root }, () => state);
	await service.activate(BACKGROUND_CONTEXT);
	return {
		harness,
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
	test("lists the root, then a subagent's child, with its ownership edge", async () => {
		const setup = await openConversations();
		try {
			await waitFor(() => setup.state.value.conversations.length === 1, "the root in the list");
			expect(setup.state.value.conversations[0]).toMatchObject({ id: setup.rootId, label: "main", root: true });

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

			// History older than the view: the pages walk back from the oldest entry and stop.
			const first = await setup.service.service.older(setup.rootId, null, 2, BACKGROUND_CONTEXT);
			expect(first.entries).toHaveLength(2);
			expect(first.cursor).toBeDefined();
			const second = await setup.service.service.older(setup.rootId, first.cursor ?? null, 2, BACKGROUND_CONTEXT);
			expect(second.entries).toHaveLength(2);
			// The pages do not overlap and every entry is older than the previous page's oldest.
			const ids = [...first.entries, ...second.entries].map((entry) => entry.id);
			expect(new Set(ids).size).toBe(ids.length);
			expect(second.entries[second.entries.length - 1]!.id).toBeLessThan(first.entries[0]!.id);
			// Walking past the beginning ends the walk rather than repeating entries.
			const third = await setup.service.service.older(setup.rootId, second.cursor ?? null, 8, BACKGROUND_CONTEXT);
			expect(third.entries.every((entry) => entry.id < second.entries[0]!.id)).toBe(true);

			// Focusing the root publishes no separate view; another conversation gets one.
			await setup.service.service.select(setup.rootId, BACKGROUND_CONTEXT);
			expect(setup.state.value.selected).toBe(setup.rootId);
			expect(setup.state.value.view).toBeNull();

			// Talking to a conversation through the service is the same durable submission.
			setup.faux.setResponses([fauxAssistantMessage("answered through the service")]);
			const accepted = await setup.service.service.prompt(
				setup.rootId,
				{ message: "through the service", images: null },
				BACKGROUND_CONTEXT,
			);
			expect(accepted).toMatchObject({ accepted: true });
			const root = (await setup.harness.conversation(Number(setup.rootId) as never, TODO_CONTEXT))!;
			const submitted = async (): Promise<boolean> => {
				const page = await root.entries({}, 10, undefined, TODO_CONTEXT);
				return page.items.some((entry) =>
					(entry.model ?? []).some((message) => JSON.stringify(message.content).includes("through the service")),
				);
			};
			await waitFor(submitted, "the prompt to settle");
			expect(await submitted()).toBe(true);
		} finally {
			await setup.close();
		}
	}, 60_000);
});
