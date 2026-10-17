/**
 * @vitest-environment happy-dom
 *
 * Measures the lower bound of a long conversation: projection cost and DOM nodes.
 * It cannot measure layout or paint, so it never fails on elapsed time; it only
 * reports numbers and checks that node growth stays linear.
 */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, UserMessage } from "@amazme/ai";
import {
	AssistantEntry,
	type ConversationId,
	type ConversationView,
	type EntryId,
	type EntryRecord,
	type JsonObject,
	UserEntry,
} from "@amazme/durable";
import { beforeEach, describe, expect, test } from "vitest";
import { buildWebView, transcriptBlocks, type WebViewInput } from "../src/view.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";

const CONVERSATION = 1 as ConversationId;

function entries(count: number): EntryRecord[] {
	const list: EntryRecord[] = [];
	for (let index = 0; index < count; index++) {
		const id = entryId(index + 1);
		if (index % 2 === 0) {
			const message: UserMessage = { role: "user", content: `question ${index}`, timestamp: index };
			list.push({ id, conversationId: CONVERSATION, kind: UserEntry.kind, model: [message] });
		} else {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: `answer ${index} ${"detail ".repeat(30)}` }],
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
				timestamp: index,
			};
			list.push({ id, conversationId: CONVERSATION, kind: AssistantEntry.kind, model: [message] });
		}
	}
	return list;
}

function viewOf(list: EntryRecord[]): ConversationView {
	return {
		conversation: { id: CONVERSATION, createdAt: 0 } as unknown as ConversationView["conversation"],
		entries: list,
		docs: {} as Record<string, JsonObject>,
	};
}

function shell(transcript: ConversationView): WebViewInput {
	return {
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
		platform: "",
		dock: { open: false, tab: "files", cwd: "", workspace: undefined, terminal: undefined, conversations: undefined },
		panel: { locale: "en", current: "chat" },
		directory: undefined,
		transcript,
		attachedId: "session",
		now: 0,
		models: undefined,
		thinkingLevels: [],
	};
}

function entryId(value: number): EntryId {
	return value as EntryId;
}

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
	document.body.innerHTML = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});

describe("transcript scale", () => {
	test("reports projection and DOM growth without asserting wall-clock time", () => {
		const renderer = createRenderer(collectPageElements());
		const measurements: Array<{ blocks: number; projectionMs: number; renderMs: number; nodes: number }> = [];

		for (const count of [200, 800]) {
			const view = viewOf(entries(count));
			const started = performance.now();
			const blocks = transcriptBlocks("en", view);
			const projected = performance.now();
			renderer.render(buildWebView(shell(view)));
			const rendered = performance.now();
			measurements.push({
				blocks: blocks.length,
				projectionMs: Math.round((projected - started) * 100) / 100,
				renderMs: Math.round((rendered - projected) * 100) / 100,
				nodes: document.body.querySelectorAll("*").length,
			});
		}

		console.table(measurements);
		expect(measurements[0]?.blocks).toBe(200);
		expect(measurements[1]?.blocks).toBe(800);
		// Node count must grow with the transcript, not with its square.
		expect(measurements[1]!.nodes).toBeLessThan(measurements[0]!.nodes * 6);
	});
});
