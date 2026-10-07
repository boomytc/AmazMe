/**
 * @vitest-environment happy-dom
 */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@amazme/ai";
import { AssistantEntry, type ConversationId, type ConversationView, type EntryId, type EntryRecord, ToolResultEntry } from "@amazme/durable";
import { beforeAll, describe, expect, test } from "vitest";
import { failureView, transcriptBlocks } from "../src/view.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";

const CONVERSATION = 1 as ConversationId;

function entryId(value: number): EntryId {
	return value as EntryId;
}

function assistantEntry(id: number, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): EntryRecord {
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
		timestamp: id,
	};
	return { id: entryId(id), conversationId: CONVERSATION, kind: AssistantEntry.kind, model: [message] };
}

function toolCall(id: string, name: string, args: ToolCall["arguments"]): ToolCall {
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

function viewOf(entries: EntryRecord[]): ConversationView {
	return {
		conversation: { id: CONVERSATION, createdAt: 0 } as unknown as ConversationView["conversation"],
		entries,
		docs: {},
	};
}

function paint(entries: EntryRecord[]): HTMLDetailsElement {
	const blocks = transcriptBlocks("en", viewOf(entries));
	const renderer = createRenderer(collectPageElements());
	renderer.render({ ...failureView("en", ""), attachedId: "session", blocks });
	const details = document.querySelector("details.disclosure");
	if (!(details instanceof HTMLDetailsElement)) throw new Error("missing tool row");
	return details;
}

function summaryOf(details: HTMLElement): string {
	return details.querySelector(".disclosure-summary")?.textContent ?? "";
}

beforeAll(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	const body = html.slice(html.indexOf("<body>") + "<body>".length, html.lastIndexOf("</body>"));
	document.body.innerHTML = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});

describe("tool card row", () => {
	test("shows the args digest on the collapsed row and the short args plus result when open", () => {
		const details = paint([
			assistantEntry(1, [toolCall("call-1", "bash", { command: "ls", cwd: "/tmp" })], "toolUse"),
			toolResultEntry(2, "call-1", "exit 0"),
		]);
		expect(details.open).toBe(false);
		expect(details.className).not.toContain("error");
		expect(details.querySelector(".disclosure-title")?.textContent).toBe("bash");
		expect(summaryOf(details)).toBe('command="ls" cwd="/tmp"');
		expect(details.querySelector(".tool-args")?.textContent).toBe("command: ls\ncwd: /tmp");
		expect(details.querySelector(".tool-output")?.textContent).toBe("exit 0");
	});

	test("does not put a JSON wall on the collapsed row", () => {
		const command = "x".repeat(400);
		const details = paint([
			assistantEntry(1, [toolCall("call-1", "bash", { command, path: "/tmp/a" })], "toolUse"),
			toolResultEntry(2, "call-1", "ok"),
		]);
		const summary = summaryOf(details);
		expect(summary).toHaveLength(100);
		expect(summary.endsWith("...")).toBe(true);
		expect(summary).not.toContain(command);
		expect(summary.includes("{")).toBe(false);
		expect(details.querySelector(".tool-args")?.textContent).toContain(`command: ${command}`);
		expect(details.querySelector(".tool-output")?.textContent).toBe("ok");
	});

	test("keeps a no-args row on the result line", () => {
		const details = paint([
			assistantEntry(1, [toolCall("call-1", "bash", {})], "toolUse"),
			toolResultEntry(2, "call-1", "exit 0"),
		]);
		expect(details.open).toBe(false);
		expect(summaryOf(details)).toBe("exit 0");
		expect(details.querySelector(".tool-args")).toBeNull();
		expect(details.querySelector(".tool-output")?.textContent).toBe("exit 0");
	});

	test("keeps an interrupted call folded, with the digest when it has args", () => {
		const bare = paint([assistantEntry(1, [toolCall("call-1", "bash", {})], "aborted")]);
		expect(bare.open).toBe(false);
		expect(bare.className).not.toContain("error");
		expect(bare.className).not.toContain("running");
		expect(summaryOf(bare)).toBe("Not run: the answer was interrupted.");
		expect(bare.querySelector(".tool-output")?.textContent).toBe("Not run: the answer was interrupted.");

		const withArgs = paint([assistantEntry(1, [toolCall("call-1", "bash", { command: "ls" })], "aborted")]);
		expect(withArgs.open).toBe(false);
		expect(withArgs.className).not.toContain("error");
		expect(summaryOf(withArgs)).toBe('command="ls"');
		expect(withArgs.querySelector(".tool-output")?.textContent).toBe("Not run: the answer was interrupted.");
	});

	test("keeps an error call folded in the error tone", () => {
		const details = paint([
			assistantEntry(1, [toolCall("call-1", "bash", { command: "ls" })], "toolUse"),
			toolResultEntry(2, "call-1", "boom", true),
		]);
		expect(details.open).toBe(false);
		expect(details.classList.contains("error")).toBe(true);
		expect(summaryOf(details)).toBe('command="ls"');
		expect(details.querySelector(".tool-output")?.textContent).toBe("boom");
	});

	test("starts a running call open", () => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-live", name: "read", arguments: { path: "notes.md" } }],
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
		const blocks = transcriptBlocks("en", {
			conversation: { id: CONVERSATION, createdAt: 0 } as unknown as ConversationView["conversation"],
			entries: [],
			docs: {
				"amazme.live": {
					generation: { attempt: 0, message: partial },
					tools: [{ callId: "call-live", name: "read", status: "running", output: "partial output" }],
				},
			} as unknown as ConversationView["docs"],
		});
		const renderer = createRenderer(collectPageElements());
		renderer.render({ ...failureView("en", ""), attachedId: "session", blocks });
		const details = [...document.querySelectorAll("details.disclosure")].find((node) => node.querySelector(".disclosure-title")?.textContent === "read");
		if (!(details instanceof HTMLDetailsElement)) throw new Error("missing running tool row");
		expect(details.open).toBe(true);
		expect(details.classList.contains("running")).toBe(true);
		expect(summaryOf(details)).toBe('path="notes.md"');
		expect(details.querySelector(".tool-args")?.textContent).toBe("path: notes.md");
		expect(details.querySelector(".tool-output")?.textContent).toBe("partial output");
	});
});
