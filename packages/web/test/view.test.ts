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
	ATTACHMENT_MAX_BYTES,
	attachmentRejection,
	approvalCards,
	approvalIndicator,
	attachments,
	buildWebView,
	failureView,
	formatBytes,
	formatAge,
	attachedSessionLabel,
	statusMeter,
	modelPicker,
	modelPickerEmpty,
	queuedInputs,
	rosterGroupOf,
	rosterGroups,
	rosterItems,
	laneLine,
	runControls,
	sessionStatus,
	transcriptBlocks,
	welcomeCard,
	type ModelsStateLike,
	type SessionDirectoryLike,
	type WebView,
	type WebViewInput,
} from "../src/view.ts";
import {
	APPROVAL_APPROVE_ACTION,
	APPROVAL_DENY_ACTION,
	FEEDBACK_DOWN_ACTION,
	FEEDBACK_UP_ACTION,
	WELCOME_DISMISS_ACTION,
	WELCOME_FILES_ACTION,
	WELCOME_SESSION_ACTION,
	WELCOME_SETTINGS_ACTION,
	ATTACHMENT_REMOVE_ACTION,
	COMPACT_ACTION,
	CONVERSATION_FORK_ACTION,
	QUEUE_CANCEL_ACTION,
	REFRESH_MODELS_ACTION,
	SESSION_REMOVE_ACTION,
	SUBMIT_MODE_ACTION,
} from "../src/actions.ts";
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

function toolCall(id: string, name = "bash", args: ToolCall["arguments"] = {}): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
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

function directoryOf(
	sessions: readonly { sessionId: string; createdAt: number; cwd?: string; name?: string }[],
): SessionDirectoryLike {
	return {
		sessions: sessions.map((session) => ({
			serverId: "00000000-0000-4000-8000-000000000001",
			sessionId: session.sessionId,
			createdAt: session.createdAt,
			cwd: session.cwd ?? "/workspace/AmazMe",
			...(session.name === undefined ? {} : { name: session.name }),
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
			"en",
			directoryOf([
				{ sessionId: "older", createdAt: NOW - 7_200_000, cwd: "/w/older" },
				{ sessionId: "newest", createdAt: NOW - 1_000, cwd: "/w/newest" },
				{ sessionId: "middle", createdAt: NOW - 60_000, cwd: "/w/middle" },
			]),
			"middle",
			NOW,
		);
		expect(roster.map((item) => item.id)).toEqual(["newest", "middle", "older"]);
		expect(roster.map((item) => item.attached)).toEqual([false, true, false]);
		expect(roster.map((item) => item.age)).toEqual(["1s", "1m", "2h"]);
		// Each row names its working directory and carries the control that asks to remove it.
		expect(roster.map((item) => item.cwd)).toEqual(["/w/newest", "/w/middle", "/w/older"]);
		expect(roster[1]?.remove).toEqual({
			id: SESSION_REMOVE_ACTION,
			label: "Remove",
			tone: "danger",
			data: "middle",
		});
		expect(rosterItems("en", undefined, undefined, NOW)).toEqual([]);
	});

	test("buckets the roster by the day each session was made, and keeps the buckets in order", () => {
		// Local time throughout, so the day boundaries are the reader's own midnights.
		const now = new Date(2026, 9, 8, 12, 0).getTime();
		const at = (month: number, day: number, hour: number): number => new Date(2026, month, day, hour).getTime();
		const roster = rosterItems(
			"en",
			directoryOf([
				{ sessionId: "ahead", createdAt: at(9, 8, 13) },
				{ sessionId: "today-late", createdAt: at(9, 8, 9) },
				{ sessionId: "yesterday", createdAt: at(9, 7, 23) },
				{ sessionId: "this-week", createdAt: at(9, 5, 10) },
				{ sessionId: "earlier", createdAt: at(8, 30, 10) },
			]),
			undefined,
			now,
		);
		expect(roster.map((item) => item.group)).toEqual(["today", "today", "yesterday", "week", "earlier"]);
		expect(rosterGroupOf(at(9, 1, 10), now)).toBe("week");
		expect(rosterGroups("en", roster).map((group) => [group.id, group.label, group.items.map((item) => item.id)])).toEqual([
			["today", "Today", ["ahead", "today-late"]],
			["yesterday", "Yesterday", ["yesterday"]],
			["week", "Previous 7 days", ["this-week"]],
			["earlier", "Earlier", ["earlier"]],
		]);
		// A bucket with no session is left out, and the labels follow the reader's language.
		expect(rosterGroups("zh", roster.filter((item) => item.group === "earlier")).map((group) => group.label)).toEqual(["更早"]);
		expect(rosterGroups("zh", [])).toEqual([]);
	});

	test("narrows the roster by id or by working directory", () => {
		const directory = directoryOf([
			{ sessionId: "alpha-1", createdAt: NOW, cwd: "/w/alpha" },
			{ sessionId: "beta-2", createdAt: NOW - 1_000, cwd: "/w/beta" },
		]);
		expect(rosterItems("en", directory, undefined, NOW, "alpha").map((item) => item.id)).toEqual(["alpha-1"]);
		expect(rosterItems("en", directory, undefined, NOW, "/w/beta").map((item) => item.id)).toEqual(["beta-2"]);
		// The filter is case-insensitive, and the whole roster comes back when it is empty.
		expect(rosterItems("en", directory, undefined, NOW, "ALPHA").map((item) => item.id)).toEqual(["alpha-1"]);
		expect(rosterItems("en", directory, undefined, NOW, "  ").map((item) => item.id)).toEqual(["alpha-1", "beta-2"]);
		expect(rosterItems("en", directory, undefined, NOW, "nothing")).toEqual([]);

		// The reader is told which empty state they are looking at.
		const view = (rosterFilter: string): WebView =>
			buildWebView({
				locale: "en",
				submitMode: "followUp",
				attachments: [],
				rosterFilter,
				approvals: undefined,
			feedback: undefined,
			showWelcome: false,
				focus: undefined,
				history: [],
				historyMore: false,
				historyLoading: false,
				draft: "",
				commands: [],
				completions: [],
				paletteSelection: 0,
				platform: "MacIntel",
			dock: {
				open: false,
				tab: "files",
				cwd: "/w",
				workspace: undefined,
				terminal: undefined,
				conversations: undefined,
			},
				panel: CHAT_PANEL,
				directory,
				transcript: undefined,
				attachedId: undefined,
				now: NOW,
				models: undefined,
				thinkingLevels: [],
			});
		expect(view("").empty).toBeUndefined();
		expect(view("nothing").empty).toBe("No session matches that filter.");
		expect(view("nothing").roster).toEqual([]);
	});

	test("shows the name /name stored and matches the roster on it", () => {
		const directory = directoryOf([
			{ sessionId: "alpha-1", createdAt: NOW, cwd: "/w/alpha", name: "Weekly report" },
			{ sessionId: "beta-2", createdAt: NOW - 1_000, cwd: "/w/beta" },
		]);
		const named = rosterItems("en", directory, "alpha-1", NOW, "week");
		expect(named.map((item) => [item.id, item.label, item.attached])).toEqual([["alpha-1", "Weekly report", true]]);
		expect(rosterItems("en", directory, undefined, NOW).map((item) => item.label)).toEqual(["Weekly report", "New session"]);
		// The filter uses the title on the row, so the untitled label finds the unnamed session only.
		expect(rosterItems("en", directory, undefined, NOW, "New session").map((item) => item.id)).toEqual(["beta-2"]);
		expect(rosterItems("en", directory, undefined, NOW, "new").map((item) => item.id)).toEqual(["beta-2"]);
		expect(rosterItems("zh", directory, undefined, NOW, "新会话").map((item) => item.id)).toEqual(["beta-2"]);
		expect(attachedSessionLabel(directory, "alpha-1")).toBe("Weekly report");
		expect(attachedSessionLabel(directory, "beta-2")).toBe("New session");
		expect(attachedSessionLabel(directory, "beta-2", "zh")).toBe("新会话");
		expect(buildWebView({
			locale: "en",
			submitMode: "followUp",
			attachments: [],
			rosterFilter: "",
			approvals: undefined,
			feedback: undefined,
			showWelcome: false,
			draft: "",
			commands: [],
			completions: [],
			paletteSelection: 0,
			platform: "",
			focus: undefined,
			history: [],
			historyMore: false,
			historyLoading: false,
			dock: { open: false, tab: "files", cwd: "/w", workspace: undefined, terminal: undefined, conversations: undefined },
			panel: CHAT_PANEL,
			directory,
			transcript: undefined,
			attachedId: "alpha-1",
			now: NOW,
			models: undefined,
			thinkingLevels: [],
		}).sessionLabel).toBe("Weekly report");
	});

	test("keeps context percent, tokens, and cost on the meter", () => {
		expect(statusMeter(undefined, undefined)).toEqual({ context: "?", tokens: "? / ?", cost: "$0.000", tone: "neutral" });
		const answer = assistantEntry(2, [{ type: "text", text: "ok" }]);
		const message = answer.model?.[0];
		if (message?.role !== "assistant") throw new Error("expected an assistant message");
		message.usage = {
			input: 8000,
			output: 1500,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 9500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const transcript = viewOf([answer], {
			"amazme.usage": {
				models: {
					"test/test": {
						input: 8000,
						output: 1500,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 9500,
						cost: { input: 1, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 1.5 },
					},
				},
				tools: {},
			},
		});
		const models: ModelsStateLike = {
			catalog: {
				revision: 1,
				availableModels: [{ provider: "test", modelId: "test", name: "Test", reasoning: false, contextWindow: 10_000 }],
			},
			configuration: { model: { provider: "test", modelId: "test" }, thinkingLevel: "off" },
			refresh: { status: "idle" },
		};
		expect(statusMeter(transcript, models)).toEqual({
			context: "95.0%",
			tokens: "9.5k / 10k",
			cost: "$1.500",
			tone: "error",
		});
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

	test("puts a short args digest on a tool call without a JSON wall", () => {
		const withArgs = transcriptBlocks(
			"en",
			viewOf([
				assistantEntry(1, [toolCall("call-1", "bash", { command: "ls", cwd: "/tmp" })], "toolUse"),
				toolResultEntry(2, "call-1", "exit 0"),
			]),
		);
		const tool = withArgs.find((block) => block.kind === "tool");
		expect(tool?.toolArgs).toEqual({ collapsed: 'command="ls" cwd="/tmp"', expanded: "command: ls\ncwd: /tmp" });
		expect(tool).toMatchObject({ title: "bash", text: "exit 0", tone: "plain", running: false });
		expect(tool?.toolArgs?.collapsed.startsWith("{")).toBe(false);

		const huge = "x".repeat(400);
		const wall = transcriptBlocks(
			"en",
			viewOf([
				assistantEntry(1, [toolCall("call-1", "bash", { command: huge, path: "/tmp/a" })], "toolUse"),
				toolResultEntry(2, "call-1", "ok"),
			]),
		);
		const digest = wall.find((block) => block.kind === "tool")?.toolArgs?.collapsed ?? "";
		expect(digest).toHaveLength(100);
		expect(digest.endsWith("...")).toBe(true);
		expect(digest).not.toContain(huge);
		expect(digest).not.toContain("path=");

		const noArgs = transcriptBlocks(
			"en",
			viewOf([
				assistantEntry(1, [toolCall("call-1")], "toolUse"),
				toolResultEntry(2, "call-1", "exit 0"),
			]),
		);
		expect(noArgs.find((block) => block.kind === "tool")).toMatchObject({
			title: "bash",
			text: "exit 0",
			tone: "plain",
			running: false,
		});
		expect(noArgs.find((block) => block.kind === "tool")?.toolArgs).toBeUndefined();

		const interrupted = transcriptBlocks(
			"en",
			viewOf([assistantEntry(1, [toolCall("call-1", "bash", { command: "ls" })], "aborted")]),
		);
		expect(interrupted.find((block) => block.kind === "tool")).toMatchObject({
			title: "bash",
			text: "Not run: the answer was interrupted.",
			tone: "plain",
			running: false,
			toolArgs: { collapsed: 'command="ls"', expanded: "command: ls" },
		});

		const failedWithArgs = transcriptBlocks(
			"en",
			viewOf([
				assistantEntry(1, [toolCall("call-1", "bash", { command: "ls" })], "toolUse"),
				toolResultEntry(2, "call-1", "boom", true),
			]),
		);
		expect(failedWithArgs.find((block) => block.kind === "tool")).toMatchObject({
			text: "boom",
			tone: "error",
			running: false,
			toolArgs: { collapsed: 'command="ls"', expanded: "command: ls" },
		});
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
					{ id: 7, mode: "steer", content: "also do this" },
					{ id: 8, mode: "write", entry: { kind: "amazme.note" } },
				],
			} as unknown as JsonObject,
		});

		const blocks = transcriptBlocks("en", view);
		expect(blocks.map((block) => block.kind)).toEqual(["user", "assistant", "tool"]);
		expect(blocks[1]).toMatchObject({ text: "streamed so far", running: true });
		expect(blocks[2]).toMatchObject({ title: "read", text: "partial output", running: true });
		expect(sessionStatus("en", view)).toBe("Running read…");
		// Every strip carries its own withdraw, addressed by the inbox submission id.
		expect(queuedInputs("en", view).map((item) => item.text)).toEqual([
			"[steer] also do this",
			"[write] <amazme.note>",
		]);
		expect(queuedInputs("en", view).map((item) => [item.id, item.cancel.id, item.cancel.data])).toEqual([
			["7", QUEUE_CANCEL_ACTION, "7"],
			["8", QUEUE_CANCEL_ACTION, "8"],
		]);
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
		const connecting = buildWebView({ locale: "en",			submitMode: "followUp",
			attachments: [],
			rosterFilter: "",
			approvals: undefined,
			feedback: undefined,
			showWelcome: false,
			focus: undefined,
			history: [],
			historyMore: false,
			historyLoading: false,
			draft: "",
			commands: [],
			completions: [],
			paletteSelection: 0,
			platform: "MacIntel",
			dock: {
				open: false,
				tab: "files",
				cwd: "/w",
				workspace: undefined,
				terminal: undefined,
				conversations: undefined,
			},
 panel: CHAT_PANEL, directory: undefined, transcript: undefined, attachedId: undefined, now: NOW, models: undefined, thinkingLevels: [] });
		expect(connecting.empty).toBe("Connecting to the host…");
		expect(connecting.blocks).toEqual([]);
		const none = buildWebView({ locale: "en",			submitMode: "followUp",
			attachments: [],
			rosterFilter: "",
			approvals: undefined,
			feedback: undefined,
			showWelcome: false,
			focus: undefined,
			history: [],
			historyMore: false,
			historyLoading: false,
			draft: "",
			commands: [],
			completions: [],
			paletteSelection: 0,
			platform: "MacIntel",
			dock: {
				open: false,
				tab: "files",
				cwd: "/w",
				workspace: undefined,
				terminal: undefined,
				conversations: undefined,
			},
 panel: CHAT_PANEL, directory: directoryOf([]), transcript: undefined, attachedId: undefined, now: NOW, models: undefined, thinkingLevels: [] });
		expect(none.empty).toBe("No sessions on this host yet.");
		const attached = buildWebView({
			locale: "en",
			submitMode: "followUp",
			attachments: [],
			rosterFilter: "",
			approvals: undefined,
			feedback: undefined,
			showWelcome: false,
			focus: undefined,
			history: [],
			historyMore: false,
			historyLoading: false,
			draft: "",
			commands: [],
			completions: [],
			paletteSelection: 0,
			platform: "MacIntel",
			dock: {
				open: false,
				tab: "files",
				cwd: "/w",
				workspace: undefined,
				terminal: undefined,
				conversations: undefined,
			},
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
			submitMode: "followUp",
			attachments: [],
			rosterFilter: "",
			approvals: undefined,
			feedback: undefined,
			showWelcome: false,
			focus: undefined,
			history: [],
			historyMore: false,
			historyLoading: false,
			draft: "",
			commands: [],
			completions: [],
			paletteSelection: 0,
			platform: "MacIntel",
			dock: {
				open: false,
				tab: "files",
				cwd: "/w",
				workspace: undefined,
				terminal: undefined,
				conversations: undefined,
			},
			panel: { locale: "zh", current: "chat" },
			directory: undefined,
			transcript: undefined,
			attachedId: undefined,
			now: NOW,
			models: undefined,
			thinkingLevels: [],
		});
		expect(zhConnecting.empty).toBe("正在连接宿主…");
		expect(zhConnecting.panel.nav.map((item) => item.label)).toEqual(["插件", "技能", "自动化", "设置"]);
	});

	test("marks a view busy only while a run is in flight", () => {
		const view = (live: JsonObject | undefined): WebView =>
			buildWebView({
			locale: "en",
			submitMode: "followUp",
			attachments: [],
			rosterFilter: "",
			approvals: undefined,
			feedback: undefined,
			showWelcome: false,
			focus: undefined,
			history: [],
			historyMore: false,
			historyLoading: false,
			draft: "",
			commands: [],
			completions: [],
			paletteSelection: 0,
			platform: "MacIntel",
			dock: {
				open: false,
				tab: "files",
				cwd: "/w",
				workspace: undefined,
				terminal: undefined,
				conversations: undefined,
			},
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
			buildWebView({ locale: "en",			submitMode: "followUp",
			attachments: [],
			rosterFilter: "",
			approvals: undefined,
			feedback: undefined,
			showWelcome: false,
			focus: undefined,
			history: [],
			historyMore: false,
			historyLoading: false,
			draft: "",
			commands: [],
			completions: [],
			paletteSelection: 0,
			platform: "MacIntel",
			dock: {
				open: false,
				tab: "files",
				cwd: "/w",
				workspace: undefined,
				terminal: undefined,
				conversations: undefined,
			},
 panel: CHAT_PANEL, directory, transcript: undefined, attachedId: undefined, now: NOW, models: undefined, thinkingLevels: [] });
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
			configuration: { model: { provider: "deepseek", modelId: "v41" }, thinkingLevel: "high" }, refresh: { status: "idle" },
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
			{ catalog: { revision: 0, availableModels: [] }, configuration: { model: null, thinkingLevel: "off" }, refresh: { status: "idle" } },
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
				configuration: { model: { provider: "kimi", modelId: "k2" }, thinkingLevel: "off" }, refresh: { status: "idle" },
			},
			["off"],
			true,
		);
		expect(notReasoning.effort).toBeUndefined();
		expect(notReasoning.label).toBe("Kimi K2");

		// A configured model the catalog no longer carries is still named as configured.
		const missing = modelPicker("en", 
			{ catalog: { revision: 2, availableModels: [] }, configuration: { model: { provider: "x", modelId: "y" }, thinkingLevel: "off" }, refresh: { status: "idle" } },
			["off"],
			true,
		);
		expect(missing.label).toBe("x/y");

		expect(modelPicker("en", undefined, [], true)).toEqual(modelPickerEmpty("en"));
		expect(modelPicker("en", undefined, [], false)).toEqual(modelPickerEmpty("en"));
		const detached = modelPicker("en", 
			{ catalog: { revision: 0, availableModels: [] }, configuration: { model: null, thinkingLevel: "off" }, refresh: { status: "idle" } },
			["off"],
			false,
		);
		expect(detached).toEqual(modelPickerEmpty("en"));
		expect(buildWebView({
			locale: "en",
			submitMode: "followUp",
			attachments: [],
			rosterFilter: "",
			approvals: undefined,
			feedback: undefined,
			showWelcome: false,
			focus: undefined,
			history: [],
			historyMore: false,
			historyLoading: false,
			draft: "",
			commands: [],
			completions: [],
			paletteSelection: 0,
			platform: "MacIntel",
			dock: {
				open: false,
				tab: "files",
				cwd: "/w",
				workspace: undefined,
				terminal: undefined,
				conversations: undefined,
			},
			panel: CHAT_PANEL,
			directory: directoryOf([]),
			transcript: undefined,
			attachedId: undefined,
			now: NOW,
			models: { catalog: { revision: 0, availableModels: [] }, configuration: { model: null, thinkingLevel: "off" }, refresh: { status: "idle" } },
			thinkingLevels: ["off"],
		}).model).toEqual(modelPickerEmpty("en"));
	});

	test("builds the picker from the attached session's models state and levels", () => {
		const view = buildWebView({
			locale: "en",
			submitMode: "followUp",
			attachments: [],
			rosterFilter: "",
			approvals: undefined,
			feedback: undefined,
			showWelcome: false,
			focus: undefined,
			history: [],
			historyMore: false,
			historyLoading: false,
			draft: "",
			commands: [],
			completions: [],
			paletteSelection: 0,
			platform: "MacIntel",
			dock: {
				open: false,
				tab: "files",
				cwd: "/w",
				workspace: undefined,
				terminal: undefined,
				conversations: undefined,
			},
			panel: CHAT_PANEL,
			directory: directoryOf([{ sessionId: "s", createdAt: NOW }]),
			transcript: viewOf([]),
			attachedId: "s",
			now: NOW,
			models: {
				catalog: { revision: 1, availableModels: [{ provider: "p", modelId: "m", name: "Model M", reasoning: true }] },
				configuration: { model: { provider: "p", modelId: "m" }, thinkingLevel: "low" }, refresh: { status: "idle" },
			},
			thinkingLevels: ["off", "low"],
		});
		expect(view.model).toMatchObject({ label: "Model M", effort: "Low", disabled: false });
		expect(failureView("en", "cannot boot: x").model).toEqual(modelPickerEmpty("en"));
	});

	test("offers the first-run guide only while the host has no sessions", () => {
		const empty = directoryOf([]);
		const input = (options: { showWelcome: boolean; directory: SessionDirectoryLike }): WebViewInput => ({
			locale: "en",
			submitMode: "followUp",
			attachments: [],
			approvals: undefined,
			feedback: undefined,
			rosterFilter: "",
			showWelcome: options.showWelcome,
			focus: undefined,
			history: [],
			historyMore: false,
			historyLoading: false,
			draft: "",
			commands: [],
			completions: [],
			paletteSelection: 0,
			platform: "MacIntel",
			dock: {
				open: false,
				tab: "files",
				cwd: "/w",
				workspace: undefined,
				terminal: undefined,
				conversations: undefined,
			},
			directory: options.directory,
			transcript: undefined,
			attachedId: undefined,
			now: NOW,
			models: undefined,
			thinkingLevels: [],
			panel: CHAT_PANEL,
		});
		const offered = buildWebView(input({ showWelcome: true, directory: empty })).welcome;
		expect(offered?.title).toContain("Welcome");
		expect(offered?.steps.map((step) => [step.id, step.tone])).toEqual([
			[WELCOME_SESSION_ACTION, "primary"],
			[WELCOME_FILES_ACTION, "default"],
			[WELCOME_SETTINGS_ACTION, "default"],
		]);
		expect(offered?.dismiss.id).toBe(WELCOME_DISMISS_ACTION);
		// A session means the reader is past the guide, and so does the setting.
		expect(buildWebView(input({ showWelcome: true, directory: directoryOf([{ sessionId: "s", createdAt: NOW }]) })).welcome).toBeUndefined();
		expect(buildWebView(input({ showWelcome: false, directory: empty })).welcome).toBeUndefined();
		// A host that has not answered yet shows no guide either.
		expect(buildWebView({ ...input({ showWelcome: true, directory: empty }), directory: undefined }).welcome).toBeUndefined();
		expect(welcomeCard("zh", { show: true })?.dismiss.label).toBe("不再显示");
	});

	test("gives every committed answer a rating, and shows the one it carries", () => {
		const view = viewOf([
			userEntry(1, "did it work?"),
			assistantEntry(2, [{ type: "text", text: "It did." }]),
			userEntry(3, "and now?"),
		]);
		const rated = transcriptBlocks("en", view, [], [
			{ sessionId: "s", conversationId: "1", entryId: "2", rating: "up" },
		]);
		const answer = rated.find((block) => block.kind === "assistant");
		expect(answer?.feedback).toEqual({
			rating: "up",
			up: { id: FEEDBACK_UP_ACTION, label: "Helpful", tone: "default", data: "2" },
			down: { id: FEEDBACK_DOWN_ACTION, label: "Not helpful", tone: "default", data: "2" },
		});
		// A user turn carries no rating, and a host that offers the surface shows it unrated.
		expect(rated.find((block) => block.kind === "user")?.feedback).toBeUndefined();
		const fresh = transcriptBlocks("en", view, [], []);
		expect(fresh.find((block) => block.kind === "assistant")?.feedback?.rating).toBeNull();
		// A host with no feedback service leaves the answers bare.
		expect(transcriptBlocks("en", view)[0]?.feedback).toBeUndefined();
		expect(transcriptBlocks("en", view).find((block) => block.kind === "assistant")?.feedback).toBeUndefined();
	});

	test("marks an answer only with the rating that belongs to its own conversation", () => {
		const view = viewOf([userEntry(1, "did it work?"), assistantEntry(2, [{ type: "text", text: "It did." }])]);
		const records = [
			{ sessionId: "other-session", conversationId: "1", entryId: "2", rating: "down" as const },
			{ sessionId: "s", conversationId: "9", entryId: "2", rating: "down" as const },
			{ sessionId: "s", conversationId: "1", entryId: "2", rating: "up" as const },
		];
		const scoped = transcriptBlocks("en", view, [], records, { sessionId: "s", conversationId: "1" });
		expect(scoped.find((block) => block.kind === "assistant")?.feedback?.rating).toBe("up");
		// Entry ids repeat across sessions, so another session's rating of entry 2 is not this one's.
		const elsewhere = transcriptBlocks("en", view, [], records, { sessionId: "s2", conversationId: "1" });
		expect(elsewhere.find((block) => block.kind === "assistant")?.feedback?.rating).toBeNull();
		const otherConversation = transcriptBlocks("en", view, [], records, {
			sessionId: "s",
			conversationId: "2",
		});
		expect(otherConversation.find((block) => block.kind === "assistant")?.feedback?.rating).toBeNull();
	});

	test("gives every waiting tool call an approve and a deny", () => {
		const cards = approvalCards("en", {
			pending: [
				{ id: "approval-1", tool: "bash", detail: '{"command":"rm -rf build"}' },
				{ id: "approval-2", tool: "write", detail: '{"path":"notes.md"}' },
			],
		});
		expect(cards.map((card) => [card.id, card.tool, card.detail])).toEqual([
			["approval-1", "bash", '{"command":"rm -rf build"}'],
			["approval-2", "write", '{"path":"notes.md"}'],
		]);
		expect(cards[0]?.approve).toEqual({
			id: APPROVAL_APPROVE_ACTION,
			label: "Approve",
			tone: "primary",
			data: "approval-1",
		});
		expect(cards[0]?.deny).toEqual({
			id: APPROVAL_DENY_ACTION,
			label: "Deny",
			tone: "danger",
			data: "approval-1",
		});
		expect(approvalCards("zh", { pending: [] })).toEqual([]);
		expect(approvalCards("zh", undefined)).toEqual([]);
	});

	test("keeps a header mark while approvals are pending, and drops it once they are decided", () => {
		const pending = [
			{ id: "approval-1", tool: "bash", detail: '{"command":"rm -rf build"}' },
			{ id: "approval-2", tool: "write", detail: '{"path":"notes.md"}' },
		];
		const base = {
			locale: "en" as const,
			submitMode: "followUp" as const,
			attachments: [],
			rosterFilter: "",
			feedback: undefined,
			showWelcome: false,
			focus: undefined,
			history: [],
			historyMore: false,
			historyLoading: false,
			draft: "",
			commands: [],
			completions: [],
			paletteSelection: 0,
			platform: "",
			dock: {
				open: false as const,
				tab: "files" as const,
				cwd: "",
				workspace: undefined,
				terminal: undefined,
				conversations: undefined,
			},
			panel: CHAT_PANEL,
			directory: undefined,
			transcript: undefined,
			attachedId: "s",
			now: NOW,
			models: undefined,
			thinkingLevels: [],
		};
		const waiting = buildWebView({ ...base, approvals: { pending } });
		// An empty transcript still carries the mark, and the cards stay the place to answer.
		expect(waiting.blocks).toEqual([]);
		expect(waiting.approvalIndicator).toEqual({ count: 2, label: "Waiting for approval 2" });
		expect(waiting.approvals.map((card) => card.id)).toEqual(["approval-1", "approval-2"]);
		expect(approvalIndicator("zh", { pending: pending.slice(0, 1) })).toEqual({ count: 1, label: "等待审批 1" });

		const approvedId = waiting.approvals[0]?.approve.data;
		const afterApprove = buildWebView({
			...base,
			approvals: { pending: pending.filter((request) => request.id !== approvedId) },
		});
		expect(afterApprove.approvalIndicator).toEqual({ count: 1, label: "Waiting for approval 1" });
		expect(afterApprove.approvals.map((card) => card.id)).toEqual(["approval-2"]);

		const deniedId = afterApprove.approvals[0]?.deny.data;
		const afterDeny = buildWebView({
			...base,
			approvals: { pending: pending.filter((request) => request.id !== approvedId && request.id !== deniedId) },
		});
		expect(afterDeny.approvalIndicator).toBeUndefined();
		expect(afterDeny.approvals).toEqual([]);
		expect(approvalIndicator("en", { pending: [] })).toBeUndefined();
		expect(approvalIndicator("en", undefined)).toBeUndefined();
		expect(failureView("en", "cannot boot: x").approvalIndicator).toBeUndefined();
	});

	test("offers the run controls: compaction, and how a busy turn takes input", () => {
		const attached = runControls("en", "steer", true, true);
		expect(attached.compact).toMatchObject({ id: COMPACT_ACTION, label: "Compact context", disabled: false });
		expect(attached.fork).toMatchObject({ label: "Fork", disabled: false });
		expect(attached.submitModes).toEqual([
			{ mode: "steer", label: "Steer", selected: true },
			{ mode: "followUp", label: "Queue", selected: false },
		]);
		// A detached page has nothing to compact, and the toggle follows the page's own choice.
		expect(runControls("en", "followUp", false, true).compact.disabled).toBe(true);
		expect(runControls("en", "followUp", false, true).fork.disabled).toBe(true);
		// An attached conversation with no entries keeps Fork visible and refuses the click.
		expect(runControls("en", "followUp", true, false).fork.disabled).toBe(true);
		expect(
			laneLine("en", {
				role: "fork",
				label: "plan",
				model: "faux/faux-1",
				thinking: "high",
				run: "working",
				detail: "",
			}),
		).toBe("Fork · plan · faux/faux-1 · thinking high · working");
		expect(
			laneLine("zh", {
				role: "subagent",
				label: "child",
				model: "",
				thinking: "off",
				run: "tool",
				detail: "bash",
			}),
		).toBe("子代理 · child · 未选模型 · 推理 off · 正在运行 bash");
		expect(runControls("zh", "followUp", true, true).submitModes).toEqual([
			{ mode: "steer", label: "介入", selected: false },
			{ mode: "followUp", label: "排队", selected: true },
		]);

		const page = (transcript: ConversationView | undefined, hasEntries: boolean) =>
			buildWebView({
				locale: "en",
				submitMode: "steer",
				attachments: [],
				rosterFilter: "",
				approvals: undefined,
				feedback: undefined,
				showWelcome: false,
				focus: undefined,
				history: [],
				historyMore: false,
				historyLoading: false,
				draft: "",
				commands: [],
				completions: [],
				paletteSelection: 0,
				platform: "MacIntel",
				dock: {
					open: true,
					tab: "conversations",
					cwd: "/w",
					workspace: undefined,
					terminal: undefined,
					conversations: {
						selected: "1",
						tasks: [],
						conversations: [{ id: "1", label: "main", root: true, children: 0, hasEntries }],
					},
				},
				panel: CHAT_PANEL,
				directory: directoryOf([{ sessionId: "s", createdAt: NOW }]),
				transcript,
				attachedId: "s",
				now: NOW,
				models: undefined,
				thinkingLevels: [],
			});
		const forkAction = (view: WebView) => view.dock.panel.groups[0]?.rows[0]?.actions?.[1];
		const empty = page(viewOf([]), false);
		expect(empty.run.fork.disabled).toBe(true);
		expect(empty.run.compact.disabled).toBe(false);
		expect(forkAction(empty)).toMatchObject({ id: CONVERSATION_FORK_ACTION, disabled: true });
		// The transcript can show the first entry before the conversation list says so.
		const filled = page(viewOf([userEntry(1, "hello")]), false);
		expect(filled.run.fork.disabled).toBe(false);
		expect(forkAction(filled)?.disabled).toBe(false);
		// A list that already recorded an entry enables Fork before that transcript arrives.
		const listed = page(undefined, true);
		expect(listed.run.fork.disabled).toBe(false);
		expect(forkAction(listed)?.disabled).toBe(false);
	});

	test("refuses an image the page cannot send and sizes the ones it can", () => {
		expect(attachmentRejection({ mediaType: "image/png", bytes: 1024 })).toBeUndefined();
		expect(attachmentRejection({ mediaType: "image/webp", bytes: ATTACHMENT_MAX_BYTES })).toBeUndefined();
		expect(attachmentRejection({ mediaType: "image/svg+xml", bytes: 10 })).toBe("composer.attachmentUnsupported");
		expect(attachmentRejection({ mediaType: "application/pdf", bytes: 10 })).toBe("composer.attachmentUnsupported");
		expect(attachmentRejection({ mediaType: "image/png", bytes: ATTACHMENT_MAX_BYTES + 1 })).toBe(
			"composer.attachmentTooLarge",
		);
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2 KB");
		expect(formatBytes(1_572_864)).toBe("1.5 MB");
	});

	test("gives every pending image its thumbnail and its own remove", () => {
		const strip = attachments("en", [
			{ id: "image-1", name: "shot.png", dataUrl: "data:image/png;base64,AAA", bytes: 2048 },
			{ id: "image-2", name: "diagram.jpg", dataUrl: "data:image/jpeg;base64,BBB", bytes: 1_048_576 },
		]);
		expect(strip.map((image) => [image.id, image.name, image.size, image.dataUrl])).toEqual([
			["image-1", "shot.png", "2 KB", "data:image/png;base64,AAA"],
			["image-2", "diagram.jpg", "1.0 MB", "data:image/jpeg;base64,BBB"],
		]);
		expect(strip.map((image) => [image.remove.id, image.remove.data, image.remove.label])).toEqual([
			[ATTACHMENT_REMOVE_ACTION, "image-1", "Remove this image"],
			[ATTACHMENT_REMOVE_ACTION, "image-2", "Remove this image"],
		]);
		expect(attachments("en", [])).toEqual([]);
	});

	test("renders a user entry's images beside its text", () => {
		const entry = userEntry(1, "look at this");
		const message = entry.model?.[0];
		if (message?.role !== "user") throw new Error("fixture is not a user entry");
		const withImage = {
			...entry,
			model: [
				{
					...message,
					content: [
						{ type: "image" as const, data: "QUJD", mimeType: "image/png" },
						{ type: "text" as const, text: "look at this" },
					],
				},
			],
		};
		const blocks = transcriptBlocks("en", viewOf([withImage]));
		expect(blocks[0]).toMatchObject({
			kind: "user",
			text: "look at this",
			images: [{ dataUrl: "data:image/png;base64,QUJD", alt: "image/png" }],
		});
		// A text-only entry carries no images key at all, so the renderer adds no element.
		expect(transcriptBlocks("en", viewOf([userEntry(2, "plain")]))[0]?.images).toBeUndefined();
	});

	test("projects the catalog's refresh state as one line", () => {
		const models = (refresh: ModelsStateLike["refresh"]): ModelsStateLike => ({
			catalog: { revision: 1, availableModels: [] },
			configuration: { model: null, thinkingLevel: "off" },
			refresh,
		});
		expect(modelPicker("en", models({ status: "idle" }), ["off"], true).refresh).toEqual({
			label: "Refresh models",
			status: undefined,
			busy: false,
		});
		expect(modelPicker("en", models({ status: "refreshing" }), ["off"], true).refresh).toMatchObject({
			status: "Refreshing models…",
			busy: true,
		});
		expect(modelPicker("en", models({ status: "done" }), ["off"], true).refresh).toMatchObject({
			status: "Models refreshed.",
			busy: false,
		});
		expect(
			modelPicker("zh", models({ status: "warning", errors: { kimi: "timeout", deepseek: "401" } }), ["off"], true)
				.refresh,
		).toMatchObject({ status: "kimi, deepseek 刷新失败。", busy: false });
		// The detached picker offers nothing to refresh.
		expect(modelPickerEmpty("en").refresh).toEqual({ label: "Refresh models", status: undefined, busy: false });
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
			"amazme.inbox": { items: [{ id: 3, mode: "steer", content: "再改一下" }] } as unknown as JsonObject,
		});
		expect(sessionStatus("zh", live)).toBe("正在运行 bash…");
		expect(queuedInputs("zh", live).map((item) => [item.text, item.cancel.label])).toEqual([
			["[介入] 再改一下", "撤回"],
		]);
	});
});
