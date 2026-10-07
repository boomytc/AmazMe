import { describe, expect, test } from "vitest";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@amazme/ai";
import {
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
} from "../src/core/messages.ts";
import { durableEntriesToSessionFile, sessionEntriesToDurableDrafts } from "../src/core/session-interop.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const user: UserMessage = { role: "user", content: "hello", timestamp: 1 };
const reply: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "hi there" }],
	provider: "test",
	model: "test",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, total: 0 } },
	stopReason: "stop",
	timestamp: 2,
};
const tool: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "read",
	content: [{ type: "text", text: "file body" }],
	isError: false,
	timestamp: 3,
};

function messageEntry(id: string, message: SessionEntry extends { message: infer M } ? M : never): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-10-07T00:00:00.000Z", message };
}

describe("a terminal transcript as durable writes", () => {
	test("carries messages by role, in order", () => {
		const { drafts, report } = sessionEntriesToDurableDrafts([
			messageEntry("1", user),
			messageEntry("2", reply),
			messageEntry("3", tool),
		]);
		expect(drafts.map((draft) => draft.kind)).toEqual([
			"amazme.user",
			"amazme.assistant",
			"amazme.tool-result",
		]);
		expect(drafts[0]?.model).toEqual([user]);
		expect(drafts[2]?.data).toEqual({ diagnostics: [] });
		expect(report).toEqual({ carried: 3, skipped: {} });
	});

	test("turns a compaction entry into a context reset carrying its summary", () => {
		const { drafts } = sessionEntriesToDurableDrafts([
			messageEntry("1", user),
			{
				type: "compaction",
				id: "2",
				parentId: "1",
				timestamp: "2026-10-07T00:01:00.000Z",
				summary: "we agreed on the plan",
				firstKeptEntryId: "1",
				tokensBefore: 100,
			},
		]);
		expect(drafts.map((draft) => draft.kind)).toEqual(["amazme.user", "amazme.reset"]);
		// The reset starts its own context and hands the summary to the model the way the terminal
		// wraps it, so the model reads the summary instead of the summarized history.
		expect(drafts[1]).toMatchObject({ head: "self" });
		const handoff = drafts[1]?.model?.[0];
		const text = handoff?.role === "user" && typeof handoff.content !== "string" ? handoff.content[0] : undefined;
		expect(text).toEqual({
			type: "text",
			text: `${COMPACTION_SUMMARY_PREFIX}we agreed on the plan${COMPACTION_SUMMARY_SUFFIX}`,
		});
	});

	test("counts what it cannot carry instead of dropping it in silence", () => {
		const { drafts, report } = sessionEntriesToDurableDrafts([
			messageEntry("1", user),
			{ type: "model_change", id: "2", parentId: "1", timestamp: "2026-10-07T00:00:00.000Z", provider: "p", modelId: "m" },
			{ type: "thinking_level_change", id: "3", parentId: "2", timestamp: "2026-10-07T00:00:00.000Z", thinkingLevel: "high" },
			{ type: "label", id: "4", parentId: "3", timestamp: "2026-10-07T00:00:00.000Z", targetId: "1", label: "start" },
			{
				type: "message",
				id: "5",
				parentId: "4",
				timestamp: "2026-10-07T00:00:00.000Z",
				message: { role: "custom", customType: "note", content: "from an extension", display: true },
			},
		]);
		expect(drafts).toHaveLength(1);
		expect(report).toEqual({
			carried: 1,
			skipped: { model_change: 1, thinking_level_change: 1, label: 1, "message:custom": 1 },
		});
	});
});

describe("a durable transcript as a terminal session file", () => {
	const header = { id: "session-1", cwd: "/work", timestamp: "2026-10-07T00:00:00.000Z" };

	test("writes the header, then one message entry per message, chained in order", () => {
		const { entries, report } = durableEntriesToSessionFile(
			[
				{ id: 1, kind: "amazme.user", model: [user] },
				{ id: 2, kind: "amazme.assistant", model: [reply] },
				{ id: 3, kind: "amazme.tool-result", model: [tool] },
			],
			header,
		);
		expect(entries[0]).toMatchObject({ type: "session", id: "session-1", cwd: "/work", version: 3 });
		expect(entries.slice(1).map((entry) => entry.type)).toEqual(["message", "message", "message"]);
		expect(entries[1]).toMatchObject({ id: "e1", parentId: null, message: user });
		expect(entries[2]).toMatchObject({ id: "e2", parentId: "e1", message: reply });
		expect(entries[3]).toMatchObject({ id: "e3", parentId: "e2", message: tool });
		expect(report).toEqual({ carried: 3, skipped: {} });
	});

	test("carries a compaction summary back as the terminal's own summary message", () => {
		const { entries } = durableEntriesToSessionFile(
			[
				{ id: 7, kind: "amazme.compaction", model: [user] },
				{
					id: 8,
					kind: "amazme.user",
					model: [
						{
							role: "user",
							content: [{ type: "text", text: `${COMPACTION_SUMMARY_PREFIX}the plan${COMPACTION_SUMMARY_SUFFIX}` }],
							timestamp: 9,
						},
					],
				},
			],
			header,
		);
		// The first entry's message is not a wrapped summary, so it stays a plain user message; the
		// second becomes the terminal's summary message.
		expect(entries[1]).toMatchObject({ id: "e7", message: user });
		expect(entries[2]).toMatchObject({
			id: "e8",
			parentId: "e7",
			message: { role: "compactionSummary", summary: "the plan" },
		});
	});

	test("writes the same ids for the same transcript, so a refresh does not reshuffle the tree", () => {
		const transcript = [
			{ id: 11, kind: "amazme.user", model: [user] },
			{ id: 12, kind: "amazme.assistant", model: [reply, tool] },
		];
		const first = durableEntriesToSessionFile(transcript, header).entries;
		const second = durableEntriesToSessionFile(transcript, header).entries;
		expect(second).toEqual(first);
		expect(first.slice(1).map((entry) => (entry as { id: string }).id)).toEqual(["e11", "e12", "e12.1"]);
	});

	test("counts an entry with no messages, such as a bare reset", () => {
		const { entries, report } = durableEntriesToSessionFile(
			[
				{ id: 5, kind: "amazme.reset" },
				{ id: 6, kind: "amazme.user", model: [user] },
			],
			header,
		);
		expect(entries).toHaveLength(2);
		expect(report).toEqual({ carried: 1, skipped: { "amazme.reset": 1 } });
	});
});
