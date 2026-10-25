/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { changesPanel } from "../src/dock.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { failureView, type TranscriptBlock } from "../src/view.ts";

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
	vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());
const patch = "--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-old\n+<img src=x onerror=alert(1)>";
const insights = { conversationId: "main", paused: null, calls: 1, cleanup: { tools: 0, images: 0 }, files: [], verification: [], notes: [], skipped: 0 };
const tool: TranscriptBlock = { id: "edit:1", kind: "tool", title: "Edit file", text: "", tone: "plain", running: false,
	result: { status: "Completed", diagnostics: [], diff: { text: patch, patch, path: "demo.ts", label: "Recorded change" } } };
const base = () => ({ ...failureView("en", ""), attachedId: "s", transcriptScope: "s:main" });
const click = (selector: string) => {
	const control = document.querySelector<HTMLButtonElement>(selector);
	if (!control) throw new Error(`Missing ${selector}`);
	control.click(); return control;
};

test("chat and changes dock share a literal diff reader but distinguish patches from bounded previews", async () => {
	const renderer = createRenderer(collectPageElements()), view = base();
	renderer.render({ ...view, blocks: [tool], dock: { ...view.dock, open: true, panel: changesPanel("en", insights, patch) } });
	const readers = [...document.querySelectorAll<HTMLElement>(".tool-diff")];
	expect(readers).toHaveLength(2);
	for (const [index, reader] of readers.entries()) {
		expect(reader.querySelector(".tool-diff-code")?.textContent).toBe(patch);
		expect(reader.querySelectorAll(".tool-diff-line.diff-header")).toHaveLength(2);
		expect(reader.querySelectorAll(".tool-diff-line.diff-hunk")).toHaveLength(1);
		expect(reader.querySelectorAll(".tool-diff-line.addition")).toHaveLength(1);
		expect(reader.querySelector("img")).toBeNull();
		reader.querySelector<HTMLButtonElement>(index === 0 ? '[aria-label="Copy patch"]' : '[aria-label="Copy displayed contents"]')!.click();
	}
	await Promise.resolve();
	expect(navigator.clipboard.writeText).toHaveBeenNthCalledWith(1, patch);
	expect(navigator.clipboard.writeText).toHaveBeenNthCalledWith(2, patch);
});

test("binary and no-longer-changed notices are not presented as patches", () => {
	const renderer = createRenderer(collectPageElements()), view = base();
	for (const text of ["二进制文件已变化。", "这个文件已不在本轮变更中。"]) {
		renderer.render({ ...view, dock: { ...view.dock, open: true, panel: changesPanel("en", insights, text) } });
		expect(document.querySelector(".tool-diff")).toBeNull();
		expect(document.querySelector(".panel-text")?.textContent).toBe(text);
		expect(document.querySelector('[aria-label="Copy patch"]')).toBeNull();
	}
});

test("diff readers without a recorded patch do not claim to copy a patch", async () => {
	const renderer = createRenderer(collectPageElements());
	renderer.render({ ...base(), blocks: [{ ...tool, result: { status: "Ended", diagnostics: [], diff: { text: "+added", label: "Recorded lines" } } }] });
	expect(document.querySelector('[aria-label="Copy patch"]')).toBeNull();
	click('[aria-label="Copy displayed contents"]'); await Promise.resolve();
	expect(navigator.clipboard.writeText).toHaveBeenCalledWith("+added");
});

test("long code and output share wrap and fold controls, preserve raw copy, and reset by conversation", async () => {
	const renderer = createRenderer(collectPageElements());
	const text = Array.from({ length: 30 }, (_, index) => `const value${index} = ${index};`).join("\n");
	const view = { ...base(), blocks: [
		{ ...tool, result: undefined, text },
		{ ...tool, id: "answer", kind: "assistant" as const, result: undefined, text: `\x60\x60\x60ts\n${text}\n\x60\x60\x60` },
	] };
	renderer.render(view);
	for (const selector of [".tool-output-reader", ".code-block"]) {
		const reader = document.querySelector<HTMLElement>(selector)!;
		expect(reader.classList.contains("collapsed")).toBe(true);
		expect(reader.querySelector<HTMLButtonElement>(".reader-fold")?.title).toBe("Show all (30 lines)");
		const wrap = reader.querySelector<HTMLButtonElement>(".reader-wrap")!;
		expect(wrap.querySelector("use")?.getAttribute("href")).toBe("#i-wrap");
		expect(wrap.getAttribute("aria-label")).toBe("Wrap long lines");
		expect(wrap.textContent).toBe("");
		wrap.click();
		expect(reader.querySelector(".reader-content")?.classList.contains("wrap")).toBe(true);
		reader.querySelector<HTMLButtonElement>(".reader-fold")!.click();
		expect(reader.classList.contains("collapsed")).toBe(false);
	}
	click('.code-block [aria-label="Copy code"]'); await Promise.resolve();
	expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(text);
	renderer.render({ ...view, locale: "zh" });
	expect(document.querySelector(".code-block")?.classList.contains("collapsed")).toBe(false);
	expect(document.querySelector(".code-block .reader-wrap")?.getAttribute("aria-pressed")).toBe("true");
	renderer.render({ ...view, transcriptScope: "s:branch" });
	expect(document.querySelector(".code-block")?.classList.contains("collapsed")).toBe(true);
	expect(document.querySelector(".code-block .reader-wrap")?.getAttribute("aria-pressed")).toBe("false");
});

test("long recorded diff previews fold without truncating the copied preview", async () => {
	const renderer = createRenderer(collectPageElements()), view = base();
	const text = "--- a/file\n+++ b/file\n@@ -0,0 +1,40 @@\n" + Array.from({ length: 40 }, (_, i) => `+line ${i}`).join("\n");
	renderer.render({ ...view, dock: { ...view.dock, open: true, panel: changesPanel("en", insights, text) } });
	expect(document.querySelector(".tool-diff")?.classList.contains("collapsed")).toBe(true);
	click(".tool-diff .reader-expand-bar");
	expect(document.querySelector(".tool-diff")?.classList.contains("collapsed")).toBe(false);
	click('[aria-label="Copy displayed contents"]'); await Promise.resolve();
	expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(text);
});

test("a changed file paints additions green and deletions red", () => {
	const renderer = createRenderer(collectPageElements()), view = base();
	const state = { ...insights, files: [{ root: "/work", path: "src/a.ts", kind: "modified" as const, added: 46, removed: 27, binary: false }] };
	renderer.render({ ...view, dock: { ...view.dock, open: true, panel: changesPanel("zh", state) } });
	const delta = document.querySelector("#dock-body .panel-delta");
	expect(delta?.querySelector(".delta-add")?.textContent).toBe("+46");
	expect(delta?.querySelector(".delta-remove")?.textContent).toBe("−27");
	expect(document.querySelector("#dock-body .panel-badge")?.textContent).toBe("修改");
});

test("a file diff opens under that file instead of after the whole list", () => {
	const renderer = createRenderer(collectPageElements()), view = base();
	const state = { ...insights, files: [
		{ root: "/work", path: "a.ts", kind: "modified" as const, added: 1, removed: 1, binary: false },
		{ root: "/work", path: "b.ts", kind: "modified" as const, added: 2, removed: 0, binary: false },
	] };
	renderer.render({ ...view, dock: { ...view.dock, open: true, panel: changesPanel("zh", state, patch, { root: "/work", path: "b.ts" }) } });
	const row = document.querySelector<HTMLElement>("#dock-body [data-row-id='change:/work/b.ts']");
	expect(row?.dataset.reviewOpen).toBe("change:/work/b.ts");
	const open = row?.querySelector<HTMLButtonElement>("[data-action='insights:diff']");
	expect(open?.textContent).toBe("收起");
	expect(open?.getAttribute("aria-pressed")).toBe("true");
	const closed = document.querySelector<HTMLButtonElement>("#dock-body [data-row-id='change:/work/a.ts'] [data-action='insights:diff']");
	expect(closed?.textContent).toBe("查看差异");
	expect(closed?.getAttribute("aria-pressed")).toBe("false");
	expect(row?.nextElementSibling?.classList.contains("review-detail")).toBe(true);
	expect(row?.nextElementSibling?.classList.contains("tool-diff")).toBe(true);
	expect(row?.nextElementSibling?.querySelector(".reader-copy")).toBeNull();
	expect(document.querySelector("#dock-body [data-row-id='change:/work/a.ts']")?.nextElementSibling?.classList.contains("review-detail")).toBe(false);
	expect(document.querySelectorAll("#dock-body .tool-diff")).toHaveLength(1);
});

test("dock reader buttons and keyboard scroll regions keep focus across live repaints", () => {
	const renderer = createRenderer(collectPageElements()), view = base();
	let text = patch + "\n+line".repeat(30);
	const render = () => renderer.render({ ...view, dock: { ...view.dock, open: true, panel: changesPanel("en", insights, text) } });
	render();
	for (const selector of [".reader-wrap", ".reader-fold", ".reader-content"]) {
		const before = document.querySelector<HTMLElement>(`.tool-diff ${selector}`)!;
		before.focus();
		text += "\n+live update";
		render();
		const after = document.querySelector<HTMLElement>(`.tool-diff ${selector}`)!;
		expect(after).not.toBe(before);
		expect(document.activeElement).toBe(after);
	}
});
