import type { Usage } from "@amazme/ai";
import {
	BranchSummaryEntry,
	type BranchSummaryUsage,
	CompactionEntry,
	type Conversation,
	type EntryId,
	type EntryRecord,
	MemoryStorage,
	type StorageWrite,
	UserEntry,
	branchSummaryModelText,
} from "@amazme/durable";
import { describe, expect, it } from "vitest";
import { allEntries, chatSetup, openChat, textOf } from "./chat-support.ts";
import { context, ControlledStorage } from "./session-support.ts";

const usage: Usage = {
	input: 3,
	output: 4,
	cacheRead: 1,
	cacheWrite: 0,
	totalTokens: 8,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

const storedUsage: BranchSummaryUsage = {
	input: 3,
	output: 4,
	cacheRead: 1,
	cacheWrite: 0,
	totalTokens: 8,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
	cacheWrite1h: null,
	reasoning: null,
};

async function users(conversation: Conversation, ...texts: string[]): Promise<EntryRecord[]> {
	const written: EntryRecord[] = [];
	for (const text of texts) {
		written.push(
			await conversation.commit(
				(tx) =>
					tx.appendEntry(UserEntry, conversation.id, {
						model: [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
					}),
				context,
			),
		);
	}
	return written;
}

function entryValues(writes: readonly StorageWrite[]): EntryRecord[] {
	return writes.flatMap((write) => (write.type === "entry" ? [write.value] : []));
}

describe("branch summary", () => {
	it("writes the summary atomically on the continuation and leaves the abandoned tail in place", async () => {
		const storage = new ControlledStorage();
		const { harness, root } = await openChat(storage, chatSetup());
		const [u1, , u3] = await users(root, "u1", "u2", "u3");
		const before = storage.commits.length;

		const continued = await root.branchSummary(
			u1!.id,
			{ summary: "LEFT", usage, details: { note: "side" } },
			{
				ownership: { kind: "ownerless" },
				init: async (tx, id) => {
					await tx.appendEntry(id, { kind: "app.marker" });
				},
			},
			context,
		);

		expect(storage.commits.length).toBe(before + 1);
		const batch = storage.commits.at(-1)!;
		const conversations = batch.flatMap((write) => (write.type === "conversation" ? [write.value] : []));
		expect(conversations).toEqual([
			expect.objectContaining({ id: continued.id, parent: { conversationId: root.id, at: u1!.id } }),
		]);
		expect(entryValues(batch).map((entry) => entry.kind)).toEqual(["app.marker", "amazme.branch-summary"]);
		const summary = entryValues(batch).at(-1)!;
		expect(summary.conversationId).toBe(continued.id);
		expect(summary.head).toBeUndefined();
		expect(BranchSummaryEntry.is(summary)).toBe(true);
		if (!BranchSummaryEntry.is(summary)) throw new Error("unreachable");
		expect(summary.data).toEqual({
			summary: "LEFT",
			from: { conversationId: root.id, entryId: u3!.id },
			usage: storedUsage,
			details: { note: "side" },
		});
		expect(textOf(summary.model?.[0])).toBe(branchSummaryModelText("LEFT"));
		expect(textOf(summary.model?.[0])).not.toContain("side");

		expect((await allEntries(root)).map((entry) => entry.kind)).toEqual(["amazme.user", "amazme.user", "amazme.user"]);
		expect((await allEntries(continued)).map((entry) => entry.kind)).toEqual([
			"amazme.user",
			"app.marker",
			"amazme.branch-summary",
		]);

		const failedAt = storage.commits.length;
		await expect(
			root.branchSummary(u1!.id, { summary: "" }, { ownership: { kind: "ownerless" } }, context),
		).rejects.toThrow(TypeError);
		await expect(
			root.branchSummary(999_999 as EntryId, { summary: "nope" }, { ownership: { kind: "ownerless" } }, context),
		).rejects.toThrow(/not visible/);
		expect(storage.commits.length).toBe(failedAt);
		await harness.close(context);
	});

	it("projects the summary into context and view the way a compaction summary's text is projected", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const [u1] = await users(root, "u1", "u2");
		await root.commit(
			(tx) =>
				tx.appendEntry(CompactionEntry, root.id, {
					head: u1!.id,
					model: [{ role: "user", content: [{ type: "text", text: "COMPACTED-OLD" }], timestamp: 1 }],
					data: { reason: "manual" },
				}),
			context,
		);
		const [u3] = await users(root, "u3", "u4");
		const continued = await root.branchSummary(
			u3!.id,
			{ summary: "LEFT THE TAIL" },
			{ ownership: { kind: "ownerless" } },
			context,
		);

		const view = await continued.context(context);
		expect(view.head).toMatchObject({ kind: "amazme.compaction", head: u1!.id });
		expect(view.entries.map((entry) => entry.kind)).toEqual([
			"amazme.compaction",
			"amazme.user",
			"amazme.user",
			"amazme.user",
			"amazme.branch-summary",
		]);
		expect(view.entries.map((entry) => textOf(entry.model?.[0]))).toEqual([
			"COMPACTED-OLD",
			"u1",
			"u2",
			"u3",
			branchSummaryModelText("LEFT THE TAIL"),
		]);
		const summaryIndex = view.entries.findIndex((entry) => entry.kind === "amazme.branch-summary");
		const compactionIndex = view.entries.findIndex((entry) => entry.kind === "amazme.compaction");
		expect(view.contributions[summaryIndex]).toEqual(view.entries[summaryIndex]!.model);
		expect(view.contributions[compactionIndex]).toEqual(view.entries[compactionIndex]!.model);
		expect(view.messages.map((message) => textOf(message))).toEqual([
			"COMPACTED-OLD",
			"u1",
			"u2",
			"u3",
			branchSummaryModelText("LEFT THE TAIL"),
		]);
		expect(view.entries.some((entry) => textOf(entry.model?.[0]) === "u4")).toBe(false);
		const summary = view.entries[summaryIndex]!;
		expect(BranchSummaryEntry.is(summary)).toBe(true);
		if (!BranchSummaryEntry.is(summary)) throw new Error("unreachable");
		expect(summary.data).toEqual({
			summary: "LEFT THE TAIL",
			from: { conversationId: root.id, entryId: (await allEntries(root)).at(-1)!.id },
		});
		expect("usage" in summary.data).toBe(false);
		expect("details" in summary.data).toBe(false);

		const state = await continued.viewState(context);
		expect(state.value.entries).toEqual(view.entries);
		state.dispose();
		await harness.close(context);
	});

	it("keeps the abandoned source when the continuation is forked again", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const [, u2] = await users(root, "u1", "u2", "u3");
		const side = await root.fork(u2!.id, { ownership: { kind: "ownerless" } }, context);
		const [abandoned] = await users(side, "side work");
		const continued = await side.branchSummary(
			u2!.id,
			{ summary: "STOPPED THE SIDE PATH", details: { why: "experiment" } },
			{ ownership: { kind: "ownerless" } },
			context,
		);

		const [after] = await users(continued, "after");
		const grandchild = await continued.fork(after!.id, { ownership: { kind: "ownerless" } }, context);
		const view = await grandchild.context(context);
		expect(view.entries.map((entry) => textOf(entry.model?.[0]))).toEqual([
			"u1",
			"u2",
			branchSummaryModelText("STOPPED THE SIDE PATH"),
			"after",
		]);
		const summary = view.entries.find((entry) => BranchSummaryEntry.is(entry));
		expect(BranchSummaryEntry.is(summary)).toBe(true);
		if (!BranchSummaryEntry.is(summary)) throw new Error("unreachable");
		expect(summary.data).toEqual({
			summary: "STOPPED THE SIDE PATH",
			from: { conversationId: side.id, entryId: abandoned!.id },
			details: { why: "experiment" },
		});
		expect(view.entries.some((entry) => textOf(entry.model?.[0]) === "u3")).toBe(false);
		expect(view.entries.some((entry) => textOf(entry.model?.[0]) === "side work")).toBe(false);
		expect((await allEntries(side)).some((entry) => entry.kind === "amazme.branch-summary")).toBe(false);
		expect((await allEntries(root)).some((entry) => entry.kind === "amazme.branch-summary")).toBe(false);

		const state = await grandchild.viewState(context);
		expect(state.value.entries).toEqual(view.entries);
		state.dispose();
		await harness.close(context);
	});
});
