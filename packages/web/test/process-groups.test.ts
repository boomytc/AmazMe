/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { processGroups } from "../src/process-groups.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { toolArgsSummary } from "../src/tool-args.ts";
import { failureView, type TranscriptBlock } from "../src/view.ts";

const tool: TranscriptBlock = { id: "tool:1", kind: "tool", title: "Run command", text: "ok", tone: "plain", running: false,
	result: { status: "Completed", diagnostics: [] }, toolArgs: { collapsed: "git status", expanded: "command: git status", source: '{"command":"git status"}' } };
const thinking: TranscriptBlock = { id: "thinking:1", kind: "thinking", title: "Thinking", text: "Inspect", tone: "muted", running: false };
const answer: TranscriptBlock = { id: "answer:1", kind: "assistant", title: "AmazMe", text: "Result", tone: "plain", running: false };
const base = () => ({ ...failureView("en", ""), attachedId: "session", transcriptScope: "session:main", blocks: [thinking, tool, answer] });

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});

test("groups adjacent events, ignores blank placeholders, preserves body and notice boundaries", () => {
	const blank = { ...answer, text: " \n " };
	const notice: TranscriptBlock = { ...answer, id: "notice", kind: "notice" };
	const items = processGroups([thinking, blank, tool, answer, { ...tool, id: "second" }, notice, thinking]);
	expect(items.map(item => item.kind)).toEqual(["process", "block", "process", "block", "process"]);
	expect(items[0]).toMatchObject({ id: thinking.id, tools: 1, thoughts: 1, state: "completed", blocks: [thinking, tool] });
});

test("does not claim success for running, failed, interrupted or missing results", () => {
	expect(processGroups([tool], true)[0]).toMatchObject({ state: "running" });
	expect(processGroups([{ ...tool, running: true, result: undefined }])[0]).toMatchObject({ state: "running" });
	expect(processGroups([{ ...tool, tone: "error" }])[0]).toMatchObject({ state: "error" });
	expect(processGroups([{ ...tool, result: undefined }])[0]).toMatchObject({ state: "interrupted" });
	expect(processGroups([{ ...tool, result: undefined, interrupted: true }], true)[0]).toMatchObject({ state: "interrupted" });
	expect(processGroups([thinking, { ...answer, kind: "notice", interrupted: true }])[0]).toMatchObject({ state: "interrupted" });
	expect(processGroups([thinking, { ...answer, kind: "notice", tone: "error" }])[0]).toMatchObject({ state: "error" });
	expect(processGroups([tool, answer], true)[0]).toMatchObject({ state: "completed" });
});

test("collapses a long completed trace into a group without losing its original rows", () => {
	const renderer = createRenderer(collectPageElements());
	renderer.render({ ...base(), blocks: [thinking, ...Array.from({ length: 30 }, (_, i) => ({ ...tool, id: `call:${i}` })), answer] });
	expect(document.querySelectorAll(".turn-process")).toHaveLength(1);
	expect(document.querySelector<HTMLElement>(".process-rows")?.hidden).toBe(true);
	expect(document.querySelectorAll(".process-rows > details")).toHaveLength(31);
	expect(document.querySelector(".process-meta")?.textContent).toBe("Completed · 30 tool calls · 1 thinking blocks");
	expect(document.querySelector(".turn-response")?.textContent).toContain("Result");
});

test("retains group expansion and focus across live updates and settlement, resets on branch switch", () => {
	const elements = collectPageElements(), renderer = createRenderer(elements);
	const view = { ...base(), busy: true, blocks: [thinking, { ...tool, running: true, result: undefined }] };
	renderer.render(view);
	const toggle = document.querySelector<HTMLButtonElement>(".process-toggle")!;
	expect(document.querySelector<HTMLElement>(".process-activity")?.hidden).toBe(false);
	expect(document.querySelector(".process-activity")?.textContent).toContain("git status");
	toggle.focus(); toggle.click();
	renderer.render({ ...view, blocks: [...view.blocks, { ...tool, id: "next", running: true }] });
	expect(document.querySelector(".process-toggle")).toBe(toggle);
	expect(document.activeElement).toBe(toggle);
	expect(toggle.getAttribute("aria-expanded")).toBe("true");
	renderer.render(base());
	expect(document.querySelector<HTMLElement>(".process-rows")?.hidden).toBe(false);
	renderer.render({ ...base(), transcriptScope: "session:branch" });
	expect(document.querySelector<HTMLElement>(".process-rows")?.hidden).toBe(true);
});

test("keeps failed diagnostics visible while the group is closed, including during later work", () => {
	const renderer = createRenderer(collectPageElements());
	const failed = { ...tool, tone: "error" as const, text: "Permission denied\nmore detail" };
	renderer.render({ ...base(), blocks: [failed] });
	expect(document.querySelector<HTMLElement>(".process-alert")?.hidden).toBe(false);
	expect(document.querySelector(".process-alert")?.textContent).toBe("1 failed steps · Permission denied");
	expect(document.querySelector<HTMLElement>(".process-rows")?.hidden).toBe(true);
	renderer.render({ ...base(), busy: true, blocks: [failed, { ...tool, id: "next", running: true, result: undefined }] });
	expect(document.querySelector(".turn-process")?.getAttribute("data-state")).toBe("running");
	expect(document.querySelector<HTMLElement>(".process-alert")?.hidden).toBe(false);
	renderer.render({ ...base(), blocks: [{ ...tool, result: undefined, interrupted: true }] });
	expect(document.querySelector(".process-alert")?.textContent).toContain("interrupted");
});

test("history uses separate groups and reopening retains the individual disclosure choice", () => {
	const renderer = createRenderer(collectPageElements());
	renderer.render({ ...base(), history: { blocks: [{ ...tool, id: "older" }], more: false, loading: false } });
	expect(document.querySelectorAll(".turn-process")).toHaveLength(2);
	const group = document.querySelector<HTMLElement>('.turn-process[data-answer-id="answer:1"]')!;
	const toggle = group.querySelector<HTMLButtonElement>(".process-toggle")!;
	toggle.click();
	const row = group.querySelector<HTMLDetailsElement>("details")!;
	row.querySelector<HTMLElement>("summary")!.click();
	const open = row.open;
	toggle.click(); toggle.click();
	expect(row.open).toBe(open);
});

test("jump to answer targets the subsequent response and does not cross a user boundary", () => {
	const renderer = createRenderer(collectPageElements());
	renderer.render(base());
	const target = document.querySelector<HTMLElement>(".turn-response")!;
	const scroll = vi.fn(); target.scrollIntoView = scroll;
	document.querySelector<HTMLButtonElement>(".process-jump")!.click();
	expect(scroll).toHaveBeenCalledWith({ block: "start" });
	expect(document.activeElement).toBe(target);
	renderer.render({ ...base(), blocks: [tool, { ...answer, kind: "user", id: "user" }, answer] });
	expect(document.querySelector<HTMLButtonElement>(".process-jump")?.hidden).toBe(true);
});

test("copies full arguments and output, not the truncated summary", async () => {
	const writeText = vi.fn(async () => {});
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
	const renderer = createRenderer(collectPageElements());
	renderer.render(base());
	document.querySelector<HTMLButtonElement>('[aria-label="Copy full arguments"]')!.click();
	document.querySelector<HTMLButtonElement>('[aria-label="Copy output"]')!.click();
	expect(writeText.mock.calls).toEqual([[tool.toolArgs!.source], [tool.text]]);
});

test("summaries handle POSIX/Windows paths and leave complex shell commands uninterpreted", () => {
	const label = (key: string) => key;
	expect(toolArgsSummary("read", { path: "/Users/reader/project/AGENTS.md" }, label)).toBe("project/AGENTS.md");
	expect(toolArgsSummary("read", { path: "C:\\project\\AGENTS.md" }, label)).toBe("project/AGENTS.md");
	expect(toolArgsSummary("ls", { path: "/" }, label)).toBe("/");
	expect(toolArgsSummary("bash", { command: "cd /tmp && git log | head -2" }, label)).toBe("cd /tmp && git log | head -2");
	expect(toolArgsSummary("custom", { name: "x" }, label)).toBe('name="x"');
});

test("does not pull a reader back to the bottom while process events stream", () => {
	const elements = collectPageElements(), renderer = createRenderer(elements);
	Object.defineProperty(elements.transcript, "scrollHeight", { configurable: true, value: 2000 });
	Object.defineProperty(elements.transcript, "clientHeight", { configurable: true, value: 500 });
	renderer.render(base());
	elements.transcript.scrollTop = 250;
	renderer.render({ ...base(), busy: true, blocks: [thinking, { ...tool, text: "updated", running: true }] });
	expect(elements.transcript.scrollTop).toBe(250);
});
