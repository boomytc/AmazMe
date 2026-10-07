import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@amazme/ai";
import {
	AssistantEntry,
	CompactionEntry,
	type ConversationId,
	type ConversationView,
	type EntryId,
	type EntryRecord,
	type JsonObject,
	ResetEntry,
	ToolResultEntry,
	UserEntry,
} from "@amazme/durable";
import { describe, expect, test } from "vitest";
import {
	buildWebView,
	failureView,
	formatAge,
	modelPicker,
	modelPickerEmpty,
	queuedInputs,
	rosterItems,
	sessionStatus,
	transcriptBlocks,
	type ModelsStateLike,
	type SessionDirectoryLike,
	type WebView,
} from "../src/view.ts";
import { thinkingLevelCopy } from "../src/strings.ts";

const CONVERSATION = 1 as ConversationId;
const NOW = 1_700_000_000_000;
/** The conversation view: the panel input every case here shares. */
const CHAT_PANEL = { locale: "en", current: "chat" } as const;

function entryId(value: number): EntryId {
	return value as EntryId;
}

function userEntry(id: number, text: string): EntryRecord {
	const message: UserMessage = { role: "user", content: text, timestamp: id };
	return { id: entryId(id), conversationId: CONVERSATION, kind: UserEntry.kind, model: [message] };
}

function assistantEntry(
	id: number,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): EntryRecord {
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: id,
	};
	return { id: entryId(id), conversationId: CONVERSATION, kind: AssistantEntry.kind, model: [message] };
}

function toolCall(id: string, name = "bash"): ToolCall {
	return { type: "toolCall", id, name, arguments: {} };
}

function toolResultEntry(id: number, callId: string, text: string, isError = false): EntryRecord {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
		timestamp: id,
	};
	return { id: entryId(id), conversationId: CONVERSATION, kind: ToolResultEntry.kind, model: [message] };
}

function viewOf(entries: EntryRecord[], docs: Record<string, JsonObject> = {}): ConversationView {
	// The view model reads entries and docs only; a conversation record is not part of these assertions.
	return {
		conversation: { id: CONVERSATION, createdAt: NOW } as unknown as ConversationView["conversation"],
		entries,
		docs,
	};
}

function directoryOf(sessions: readonly { sessionId: string; createdAt: number }[]): SessionDirectoryLike {
	return {
		sessions: sessions.map((session) => ({
			serverId: "00000000-0000-4000-8000-000000000001",
			sessionId: session.sessionId,
			createdAt: session.createdAt,
		})),
	};
}

describe("web view model", () => {
	test("formats ages the way the roster shows them", () => {
		expect(formatAge(NOW, NOW)).toBe("0s");
		expect(formatAge(NOW - 59_000, NOW)).toBe("59s");
		expect(formatAge(NOW - 60_000, NOW)).toBe("1m");
		expect(formatAge(NOW - 3_600_000, NOW)).toBe("1h");
		expect(formatAge(NOW - 48 * 3_600_000, NOW)).toBe("2d");
	});

	test("lists sessions newest first and marks the attached one", () => {
		const roster = rosterItems(
			directoryOf([
				{ sessionId: "older", createdAt: NOW - 7_200_000 },
				{ sessionId: "newest", createdAt: NOW - 1_000 },
				{ sessionId: "middle", createdAt: NOW - 60_000 },
			]),
			"middle",
			NOW,
		);
		expect(roster.map((item) => item.id)).toEqual(["newest", "middle", "older"]);
		expect(roster.map((item) => item.attached)).toEqual([false, true, false]);
		expect(roster.map((item) => item.age)).toEqual(["1s", "1m", "2h"]);
		expect(rosterItems(undefined, undefined, NOW)).toEqual([]);
	});

	test("projects committed entries into user, assistant, thinking, tool, and notice blocks", () => {
		const blocks = transcriptBlocks("en", 
			viewOf([
				userEntry(1, "does this work?"),
				assistantEntry(2, [
					{ type: "thinking", thinking: "Consider the failing case." },
					{ type: "text", text: "Running it." },
					toolCall("call-1"),
				]),
				toolResultEntry(3, "call-1", "exit 0"),
				{
					id: entryId(4),
					conversationId: CONVERSATION,
					kind: CompactionEntry.kind,
					model: [userEntry(0, "summary text").model![0]!],
				},
				{ id: entryId(5), conversationId: CONVERSATION, kind: ResetEntry.kind },
			]),
		);
		expect(blocks.map((block) => [block.kind, block.title])).toEqual([
			["user", "You"],
			["thinking", "Thinking"],
			["assistant", "AmazMe"],
			["tool", "bash"],
			["notice", "Compaction"],
			["notice", "New context"],
		]);
		expect(blocks[0]?.text).toBe("does this work?");
		expect(blocks[1]?.text).toBe("Consider the failing case.");
		expect(blocks[2]?.text).toBe("Running it.");
		expect(blocks[3]?.text).toBe("exit 0");
		expect(blocks[3]?.running).toBe(false);
		expect(blocks[4]?.tone).toBe("muted");
	});

	test("marks a tool call the answer never ran, and one whose result failed", () => {
		const interrupted = transcriptBlocks("en", 
			viewOf([assistantEntry(1, [{ type: "text", text: "…" }, toolCall("call-1")], "aborted")]),
		);
		expect(interrupted.find((block) => block.kind === "tool")).toMatchObject({
			title: "bash",
			text: "Not run: the answer was interrupted.",
			tone: "plain",
			running: false,
		});

		const failed = transcriptBlocks("en", 
			viewOf([
				assistantEntry(1, [{ type: "text", text: "…" }, toolCall("call-1")], "toolUse"),
				toolResultEntry(2, "call-1", "boom", true),
			]),
		);
		expect(failed.find((block) => block.kind === "tool")).toMatchObject({ text: "boom", tone: "error" });
	});

	test("surfaces a committed answer that failed instead of leaving an empty block", () => {
		// A failed answer with no text is the notice alone: no empty card above it.
		const failed = transcriptBlocks("en", viewOf([assistantEntry(1, [], "error")]));
		expect(failed.map((block) => [block.kind, block.title, block.tone])).toEqual([["notice", "Error", "error"]]);
		expect(failed[0]?.text).toBe("Unknown error");
		const withText = transcriptBlocks("en", viewOf([assistantEntry(1, [{ type: "text", text: "partial" }], "error", "no credentials")]));
		expect(withText.map((block) => [block.kind, block.title])).toEqual([
			["assistant", "AmazMe"],
			["notice", "Error"],
		]);

		const withReason = transcriptBlocks("en", viewOf([assistantEntry(1, [], "error", "no credentials")]));
		expect(withReason).toHaveLength(1);
		expect(withReason[0]).toMatchObject({ title: "Error", text: "no credentials", tone: "error" });

		const aborted = transcriptBlocks("en", viewOf([assistantEntry(1, [{ type: "text", text: "half" }], "aborted")]));
		expect(aborted[1]).toMatchObject({ title: "Aborted", text: "Operation aborted", tone: "error" });

		const truncated = transcriptBlocks("en", viewOf([assistantEntry(1, [{ type: "text", text: "cut" }], "length")]));
		expect(truncated[1]).toMatchObject({ title: "Truncated", tone: "error" });

		// A tool-calling answer reports the failure on its cards, not as a notice.
		const withTool = transcriptBlocks("en", viewOf([assistantEntry(1, [toolCall("call-1")], "aborted")]));
		expect(withTool.some((block) => block.kind === "notice")).toBe(false);
	});

	test("projects the live partial, running tools, status, and queue from the view docs", () => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "streamed so far" }, toolCall("call-live", "read")],
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 9,
		};
		const view = viewOf([userEntry(1, "hello")], {
			"amazme.live": {
				run: { taskId: 2, inputs: [1] },
				generation: { attempt: 0, message: partial as unknown as JsonObject },
				tools: [{ callId: "call-live", name: "read", status: "running", output: "partial output" }],
			} as unknown as JsonObject,
			"amazme.inbox": {
				items: [
					{ mode: "steer", content: "also do this", submissionId: 1, requestId: "r1" },
					{ mode: "write", entry: { kind: "amazme.note" }, submissionId: 2, requestId: "r2" },
				],
			} as unknown as JsonObject,
		});

		const blocks = transcriptBlocks("en", view);
		expect(blocks.map((block) => block.kind)).toEqual(["user", "assistant", "tool"]);
		expect(blocks[1]).toMatchObject({ text: "streamed so far", running: true });
		expect(blocks[2]).toMatchObject({ title: "read", text: "partial output", running: true });
		expect(sessionStatus("en", view)).toBe("Running read…");
		expect(queuedInputs("en", view)).toEqual(["[steer] also do this", "[write] <amazme.note>"]);
	});

	test("keeps the status precedence the TUI indicator uses", () => {
		const withLive = (live: JsonObject): ConversationView => viewOf([], { "amazme.live": live });
		expect(sessionStatus("en", undefined)).toBe("");
		expect(sessionStatus("en", viewOf([]))).toBe("");
		expect(sessionStatus("en", withLive({ run: { taskId: 1, inputs: [] } }))).toBe("Working…");
		expect(sessionStatus("en", withLive({ generation: { attempt: 0, retry: { at: 1, error: "overloaded" } } }))).toBe(
			"Retrying (attempt 1): overloaded",
		);
		expect(sessionStatus("en", withLive({ generation: { attempt: 0, deferred: { pollAt: 1 } } }))).toBe(
			"Waiting for deferred response…",
		);
		expect(sessionStatus("en", withLive({ compactions: [{ taskId: 1, reason: "manual", attempt: 0 }] }))).toBe(
			"Compacting (manual)…",
		);
		expect(
			sessionStatus("en", withLive({ compactions: [{ taskId: 1, reason: "manual", attempt: 1, retry: { at: 1, error: "x" } }] })),
		).toBe("Retrying manual compaction (attempt 2)…");
		expect(
			sessionStatus("en", 
				withLive({
					run: { taskId: 1, inputs: [] },
					tools: [{ callId: "c", name: "bash", status: "running" }],
				}),
			),
		).toBe("Running bash…");
		expect(sessionStatus("en", withLive({ tools: [{ callId: "c", name: "bash", status: "pending" }] }))).toBe("");
	});

	test("reports the empty states the roster and transcript show", () => {
		const connecting = buildWebView({ locale: "en", panel: CHAT_PANEL, directory: undefined, transcript: undefined, attachedId: undefined, now: NOW, models: undefined, thinkingLevels: [] });
		expect(connecting.empty).toBe("Connecting to the host…");
		expect(connecting.blocks).toEqual([]);
		const none = buildWebView({ locale: "en", panel: CHAT_PANEL, directory: directoryOf([]), transcript: undefined, attachedId: undefined, now: NOW, models: undefined, thinkingLevels: [] });
		expect(none.empty).toBe("No sessions on this host yet.");
		const attached = buildWebView({
			locale: "en",
			panel: CHAT_PANEL,
			directory: directoryOf([{ sessionId: "s", createdAt: NOW }]),
			transcript: viewOf([]),
			attachedId: "s",
			now: NOW,
			models: undefined,
			thinkingLevels: [],
		});
		expect(attached.empty).toBeUndefined();
		expect(attached.attachedId).toBe("s");
		expect(attached.roster[0]?.attached).toBe(true);
		expect(failureView("en", "cannot boot: x")).toMatchObject({ empty: "cannot boot: x", blocks: [], roster: [] });
		expect(failureView("zh", "无法启动：x")).toMatchObject({ locale: "zh", empty: "无法启动：x" });
		const zhConnecting = buildWebView({
			locale: "zh",
			panel: { locale: "zh", current: "chat" },
			directory: undefined,
			transcript: undefined,
			attachedId: undefined,
			now: NOW,
			models: undefined,
			thinkingLevels: [],
		});
		expect(zhConnecting.empty).toBe("正在连接宿主…");
		expect(zhConnecting.panel.nav.map((item) => item.label)).toEqual(["插件", "技能", "设置"]);
	});

	test("marks a view busy only while a run is in flight", () => {
		const view = (live: JsonObject | undefined): WebView =>
			buildWebView({
			locale: "en",
			panel: CHAT_PANEL,
				directory: directoryOf([{ sessionId: "s", createdAt: NOW }]),
				transcript: viewOf([], live === undefined ? {} : { "amazme.live": live }),
				attachedId: "s",
				now: NOW,
				models: undefined,
				thinkingLevels: [],
			});
		expect(view(undefined).busy).toBe(false);
		expect(view({ tools: [{ callId: "c", name: "bash", status: "running" }] }).busy).toBe(false);
		expect(view({ run: { taskId: 1, inputs: [] } }).busy).toBe(true);
	});

	test("enables the new-session bar only while the host's directory is reachable", () => {
		const view = (directory: SessionDirectoryLike | undefined): WebView =>
			buildWebView({ locale: "en", panel: CHAT_PANEL, directory, transcript: undefined, attachedId: undefined, now: NOW, models: undefined, thinkingLevels: [] });
		expect(view(undefined).newSession).toEqual({ enabled: false });
		expect(view(directoryOf([])).newSession).toEqual({ enabled: true });
		expect(failureView("en", "cannot boot: x").newSession).toEqual({ enabled: false });
	});

	test("projects the model picker from the host's catalog and configuration", () => {
		const models: ModelsStateLike = {
			catalog: {
				revision: 3,
				availableModels: [
					{ provider: "kimi", modelId: "k2", name: "Kimi K2", reasoning: false },
					{ provider: "deepseek", modelId: "v41", name: "DeepSeek V4.1", reasoning: true },
					{ provider: "deepseek", modelId: "flash", name: "DeepSeek Flash", reasoning: false },
				],
			},
			configuration: { model: { provider: "deepseek", modelId: "v41" }, thinkingLevel: "high" },
		};

		const picker = modelPicker("en", models, ["off", "low", "high"], true);
		expect(picker.label).toBe("DeepSeek V4.1");
		expect(picker.effort).toBe("High");
		expect(picker.disabled).toBe(false);
		expect(picker.empty).toBeUndefined();
		expect(picker.groups.map((group) => group.provider)).toEqual(["deepseek", "kimi"]);
		expect(picker.groups[0]?.options.map((option) => [option.label, option.selected])).toEqual([
			["DeepSeek V4.1", true],
			["DeepSeek Flash", false],
		]);
		expect(picker.levels.map((level) => [level.label, level.selected])).toEqual([
			["Off", false],
			["Low", false],
			["High", true],
		]);
		expect(picker.levelsEmpty).toBeUndefined();
	});

	test("keeps the picker explainable when the catalog, the levels, or the session are missing", () => {
		const emptyCatalog = modelPicker("en", 
			{ catalog: { revision: 0, availableModels: [] }, configuration: { model: null, thinkingLevel: "off" } },
			["off"],
			true,
		);
		expect(emptyCatalog.label).toBe("No model");
		expect(emptyCatalog.groups).toEqual([]);
		expect(emptyCatalog.empty).toBe("No models available.");
		// A model with nothing above `off` still says so instead of showing an empty group.
		expect(emptyCatalog.levelsEmpty).toBe("This model provides no reasoning effort levels.");

		const notReasoning = modelPicker("en", 
			{
				catalog: {
					revision: 1,
					availableModels: [{ provider: "kimi", modelId: "k2", name: "Kimi K2", reasoning: false }],
				},
				configuration: { model: { provider: "kimi", modelId: "k2" }, thinkingLevel: "off" },
			},
			["off"],
			true,
		);
		expect(notReasoning.effort).toBeUndefined();
		expect(notReasoning.label).toBe("Kimi K2");

		// A configured model the catalog no longer carries is still named as configured.
		const missing = modelPicker("en", 
			{ catalog: { revision: 2, availableModels: [] }, configuration: { model: { provider: "x", modelId: "y" }, thinkingLevel: "off" } },
			["off"],
			true,
		);
		expect(missing.label).toBe("x/y");

		expect(modelPicker("en", undefined, [], true)).toEqual(modelPickerEmpty("en"));
		expect(modelPicker("en", undefined, [], false)).toEqual(modelPickerEmpty("en"));
		const detached = modelPicker("en", 
			{ catalog: { revision: 0, availableModels: [] }, configuration: { model: null, thinkingLevel: "off" } },
			["off"],
			false,
		);
		expect(detached).toEqual(modelPickerEmpty("en"));
		expect(buildWebView({
			locale: "en",
			panel: CHAT_PANEL,
			directory: directoryOf([]),
			transcript: undefined,
			attachedId: undefined,
			now: NOW,
			models: { catalog: { revision: 0, availableModels: [] }, configuration: { model: null, thinkingLevel: "off" } },
			thinkingLevels: ["off"],
		}).model).toEqual(modelPickerEmpty("en"));
	});

	test("builds the picker from the attached session's models state and levels", () => {
		const view = buildWebView({
			locale: "en",
			panel: CHAT_PANEL,
			directory: directoryOf([{ sessionId: "s", createdAt: NOW }]),
			transcript: viewOf([]),
			attachedId: "s",
			now: NOW,
			models: {
				catalog: { revision: 1, availableModels: [{ provider: "p", modelId: "m", name: "Model M", reasoning: true }] },
				configuration: { model: { provider: "p", modelId: "m" }, thinkingLevel: "low" },
			},
			thinkingLevels: ["off", "low"],
		});
		expect(view.model).toMatchObject({ label: "Model M", effort: "Low", disabled: false });
		expect(failureView("en", "cannot boot: x").model).toEqual(modelPickerEmpty("en"));
	});

	test("names thinking levels in the reader's language, capitalizing an unknown one", () => {
		expect(thinkingLevelCopy("en", "off")).toBe("Off");
		expect(thinkingLevelCopy("en", "medium")).toBe("Medium");
		expect(thinkingLevelCopy("en", "xhigh")).toBe("XHigh");
		expect(thinkingLevelCopy("zh", "medium")).toBe("中");
		expect(thinkingLevelCopy("zh", "")).toBe("");
		expect(thinkingLevelCopy("zh", "future-level")).toBe("Future-level");
	});

	test("projects the conversation in the reader's language", () => {
		const blocks = transcriptBlocks(
			"zh",
			viewOf([
				userEntry(1, "这样行吗？"),
				assistantEntry(2, [
					{ type: "thinking", thinking: "先想一下。" },
					{ type: "text", text: "试一下。" },
					toolCall("call-1"),
				]),
				toolResultEntry(3, "call-1", ""),
			]),
		);
		expect(blocks.map((block) => block.title)).toEqual(["你", "思考", "AmazMe", "bash"]);
		expect(blocks[2]?.text).toBe("试一下。");
		expect(blocks[3]?.text).toBe("（无输出）");

		const live = viewOf([], {
			"amazme.live": { run: { taskId: 1, inputs: [] }, tools: [{ callId: "c", name: "bash", status: "running" }] } as unknown as JsonObject,
			"amazme.inbox": { items: [{ mode: "steer", content: "再改一下", submissionId: 1, requestId: "r1" }] } as unknown as JsonObject,
		});
		expect(sessionStatus("zh", live)).toBe("正在运行 bash…");
		expect(queuedInputs("zh", live)).toEqual(["[介入] 再改一下"]);
	});
});
