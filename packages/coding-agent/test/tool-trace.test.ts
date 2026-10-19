import type { AssistantMessage, ToolResultMessage } from "@amazme/ai";
import type { ConversationView, EntryRecord } from "@amazme/durable";
import { Container, type TUI, type TuiMouseEvent } from "@amazme/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { createAllToolRenderers } from "../src/core/tools/renderers/index.ts";
import { ExperimentalChatView } from "../src/host/client-tui-chat.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolTracePlacement, ToolTraceRun } from "../src/modes/interactive/components/tool-trace.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const renderers = createAllToolRenderers();

function tui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function card(
	name: keyof typeof renderers,
	id: string,
	args: Record<string, unknown>,
	result?: { text: string; isError?: boolean; details?: unknown; partial?: boolean },
): ToolExecutionComponent {
	const component = new ToolExecutionComponent(name, id, args, {}, renderers[name], tui(), "/work");
	component.setArgsComplete();
	if (result) {
		component.updateResult(
			{
				content: [{ type: "text", text: result.text }],
				details: result.details,
				isError: result.isError === true,
			},
			result.partial === true,
		);
	}
	return component;
}

function lines(component: { render(width: number): string[] }): string[] {
	return component
		.render(120)
		.map((line) => stripAnsi(line).trimEnd())
		.filter((line) => line.trim().length > 0);
}

describe("tool trace rows", () => {
	beforeAll(() => initTheme("dark"));

	test("a settled read is one line, and consecutive reads and searches fold", () => {
		const run = new ToolTraceRun();
		const read = card("read", "r1", { path: "a.ts" }, { text: "secret-a" });
		run.add(read);
		expect(lines(run)).toEqual([" ◆ Read a.ts"]);
		expect(lines(run).join("\n")).not.toContain("secret-a");

		run.add(card("read", "r2", { path: "b.ts" }, { text: "secret-b" }));
		run.add(card("grep", "g1", { pattern: "secret", path: "src" }, { text: "a.ts:1:secret-a\nb.ts:1:secret-b" }));
		expect(lines(run)).toEqual([" ◆ Explored 2 files, 1 search"]);
	});

	test("a single search and a file-plus-search run use the shorter labels", () => {
		const search = new ToolTraceRun();
		search.add(
			card("grep", "g1", { pattern: "export type Api", path: "**/ai/src/**/*.ts" }, {
				text: "a.ts:1:export type Api\nb.ts:4:export type Api",
			}),
		);
		expect(lines(search)).toEqual([' ◆ Search "export type Api" in **/ai/src/**/*.ts (2 matches in 2 files)']);

		const mixed = new ToolTraceRun();
		mixed.add(card("read", "r1", { path: "edit.ts" }, { text: "export" }));
		mixed.add(card("grep", "g2", { pattern: "format", path: "edit.ts" }, { text: "edit.ts:3:format" }));
		expect(lines(mixed)).toEqual([" ◆ Explored edit.ts, 1 search"]);
	});

	test("a pending or failed call stays out of the summary and keeps its own row", () => {
		const run = new ToolTraceRun();
		run.add(card("read", "r1", { path: "a.ts" }, { text: "a" }));
		run.add(card("read", "r2", { path: "b.ts" }, { text: "missing", isError: true }));
		run.add(card("bash", "b1", { command: "npm test" }, { text: "", partial: true }));
		run.add(card("bash", "b2", { command: "npm run build" }, { text: "ok" }));
		const rendered = lines(run);
		expect(rendered.some((line) => line.includes("Explored"))).toBe(false);
		expect(rendered.some((line) => line.includes("Ran 2"))).toBe(false);
		expect(rendered.some((line) => line.includes("Read a.ts"))).toBe(true);
		expect(rendered.some((line) => line.includes("b.ts"))).toBe(true);
		expect(rendered.some((line) => line.includes("npm test"))).toBe(true);
		expect(rendered.some((line) => line.includes("Ran npm run build"))).toBe(true);
	});

	test("one edit stays a stat line and several edits fold", () => {
		const diff = "+1 next\n-1 previous";
		const run = new ToolTraceRun();
		const edit = card("edit", "e1", { path: "a.ts" }, { text: "updated", details: { diff } });
		run.add(edit);
		const alone = lines(run);
		expect(alone).toHaveLength(1);
		expect(alone[0]).toContain("Edit a.ts");
		expect(alone[0]).toContain("+1/-1");
		expect(alone.join("\n")).not.toContain("next");

		run.add(card("edit", "e2", { path: "b.ts" }, { text: "updated", details: { diff } }));
		expect(lines(run)).toEqual([" ◆ Edited 2 files +2 -2"]);

		edit.setExpanded(true);
		run.cards[1]?.setExpanded(true);
		const expanded = lines(run);
		expect(expanded[0]).toContain("Edited 2 files");
		expect(expanded.join("\n")).toContain("next");
		expect(expanded.join("\n")).toContain("previous");
	});

	test("consecutive commands fold, and clicking the summary shows their output", () => {
		const run = new ToolTraceRun();
		run.add(card("bash", "b1", { command: "pwd" }, { text: "/work" }));
		run.add(card("bash", "b2", { command: "ls" }, { text: "src" }));
		expect(lines(run)).toEqual([" ◆ Ran 2 commands"]);

		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 0,
			y: 0,
			screenX: 0,
			screenY: 0,
			width: 120,
			height: 1,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(run.handleMouse(event)?.handled).toBe(true);
		const expanded = lines(run).join("\n");
		expect(expanded).toContain("pwd");
		expect(expanded).toContain("/work");
		expect(expanded).toContain("ls");
		expect(expanded).toContain("src");
	});
});

describe("client transcript tool rows", () => {
	beforeAll(() => initTheme("dark"));

	test("folds a settled read run and leaves the failed call on its own row", () => {
		const view = new ExperimentalChatView(tui(), "/work");
		view.apply(transcript());
		const rendered = lines(view.transcript);
		expect(rendered.some((line) => line.includes("Explored 2 files"))).toBe(true);
		expect(rendered.some((line) => line.includes("grep"))).toBe(true);
		expect(rendered.join("\n")).not.toContain("secret-a");
	});
});

function transcript(): ConversationView {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "r2", name: "read", arguments: { path: "b.ts" } },
			{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "secret", path: "src" } },
		],
		provider: "test",
		model: "test",
		api: "openai-completions",
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	};
	const results: ToolResultMessage[] = [
		{ role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "secret-a" }], isError: false, timestamp: 2 },
		{ role: "toolResult", toolCallId: "r2", toolName: "read", content: [{ type: "text", text: "secret-b" }], isError: false, timestamp: 3 },
		{ role: "toolResult", toolCallId: "g1", toolName: "grep", content: [{ type: "text", text: "no matches" }], isError: true, timestamp: 4 },
	];
	const entries = [
		{ id: 1, conversationId: "c", kind: "amazme.assistant", model: [assistant] },
		...results.map((result, index) => ({
			id: index + 2,
			conversationId: "c",
			kind: "amazme.tool-result",
			model: [result],
		})),
	] as unknown as EntryRecord[];
	return { conversation: {} as ConversationView["conversation"], entries, docs: {} };
}

describe("durable transcript placement", () => {
	beforeAll(() => initTheme("dark"));

	test("closes a run at a non-tool row, which is how the durable transcript separates turns", () => {
		const chat = new Container();
		const placement = new ToolTracePlacement(chat);
		placement.add(card("read", "r1", { path: "a.ts" }, { text: "a" }));
		placement.add(card("read", "r2", { path: "b.ts" }, { text: "b" }));
		placement.close();
		placement.add(card("bash", "b1", { command: "pwd" }, { text: "/work" }));
		placement.add(card("bash", "b2", { command: "ls" }, { text: "src" }));
		expect(lines(chat)).toEqual([" ◆ Explored 2 files", " ◆ Ran 2 commands"]);
	});
});
