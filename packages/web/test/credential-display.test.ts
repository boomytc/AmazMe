/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { failureView } from "../src/view.ts";
import type { TranscriptBlock, WebView } from "../src/view.ts";

const key = "sk-" + "a1B2c3D4".repeat(4);
const block: TranscriptBlock = { id: "1", kind: "user", title: "You", text: `use ${key}`, tone: "plain", running: false };
const toggle = () => document.querySelector<HTMLButtonElement>(".bubble .credential-toggle")!;

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test("sent and queued credentials start masked; each native button reveals only its own range", () => {
	const renderer = createRenderer(collectPageElements());
	const view: WebView = { ...failureView("en", ""), attachedId: "s", blocks: [block], queue: [
		{ id: "q", text: key, cancel: { id: "withdraw", label: "Withdraw", weight: "text" } },
	] };
	renderer.render(view);
	expect(document.querySelector(".bubble")?.textContent).not.toContain(key);
	expect(document.querySelector(".queue-text")?.textContent).not.toContain(key);
	expect(toggle().type).toBe("button");
	expect(toggle().getAttribute("aria-label")).toBe("Show credential");
	toggle().click();
	expect(document.querySelector(".bubble .credential-value")?.textContent).toBe(key);
	expect(toggle().getAttribute("aria-pressed")).toBe("true");
	expect(document.querySelector(".queue-text")?.textContent).not.toContain(key);
	// An unrelated repaint preserves the explicit reveal choice and control identity.
	const control = toggle();
	renderer.render({ ...view, sessionLabel: "renamed" });
	expect(toggle()).toBe(control);
	toggle().click();
	expect(document.querySelector(".bubble")?.textContent).not.toContain(key);
});

test("copy uses the original message; changed values, locale and conversation scope remask", async () => {
	const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
	const renderer = createRenderer(collectPageElements());
	const view = { ...failureView("en", ""), attachedId: "s", blocks: [block] };
	renderer.render(view);
	document.querySelector<HTMLButtonElement>(".turn-user .message-action")?.click();
	await Promise.resolve();
	expect(write).toHaveBeenCalledWith(block.text);
	expect(view.blocks[0]?.text).toBe(block.text);
	toggle().click();
	renderer.render({ ...view, blocks: [{ ...block, text: `new ${key}` }] });
	expect(toggle().getAttribute("aria-pressed")).toBe("false");
	toggle().click();
	renderer.render({ ...view, locale: "zh" });
	expect(toggle().getAttribute("aria-label")).toBe("显示凭据");
	expect(document.querySelector(".bubble")?.textContent).not.toContain(key);
	toggle().click();
	renderer.render({ ...view, attachedId: "different", locale: "zh" });
	expect(toggle().getAttribute("aria-pressed")).toBe("false");
});

test("credential copies explicitly distinguish originals from masked text, even after reveal and failed writes", async () => {
	vi.useFakeTimers();
	const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
	const renderer = createRenderer(collectPageElements());
	const second = "sk-" + "b2C3d4E5".repeat(4);
	const text = `first ${key}\nsecond ${second}`;
	renderer.render({ ...failureView("zh", ""), attachedId: "s", blocks: [{ ...block, text }] });
	const original = document.querySelector<HTMLButtonElement>('[aria-label="复制原文（含凭据）"]')!;
	const masked = document.querySelector<HTMLButtonElement>('[aria-label="复制脱敏文本"]')!;
	expect(original.textContent).toContain("含凭据");
	expect(document.body.innerHTML).not.toContain(key);
	expect(document.body.innerHTML).not.toContain(second);
	masked.click(); await Promise.resolve();
	const copied = write.mock.calls.at(-1)?.[0];
	expect(copied).toContain("first "); expect(copied).toContain("\nsecond ");
	expect(copied).not.toContain(key); expect(copied).not.toContain(second);
	toggle().click();
	masked.click(); await Promise.resolve(); expect(write).toHaveBeenLastCalledWith(copied);
	original.click(); await Promise.resolve(); expect(write).toHaveBeenLastCalledWith(text);
	await vi.advanceTimersByTimeAsync(1200);
	expect(original.getAttribute("aria-label")).toBe("复制原文（含凭据）");
	expect(original.textContent).toContain("含凭据");
	write.mockRejectedValueOnce(new Error("clipboard denied"));
	original.click(); await Promise.resolve();
	expect(original.textContent).toContain("复制失败");
	await vi.advanceTimersByTimeAsync(1200);
	expect(original.title).toBe("复制原文（含凭据）");
	expect(original.textContent).toContain("含凭据");
});

test("ordinary users and assistant answers keep the ordinary copy action", () => {
	const renderer = createRenderer(collectPageElements());
	renderer.render({ ...failureView("en", ""), attachedId: "s", blocks: [{ ...block, text: "plain text" }, { ...block, id: "answer", kind: "assistant" }] });
	expect(document.querySelectorAll('.turn-actions [aria-label="Copy"]')).toHaveLength(2);
	expect(document.querySelectorAll(".copy-sensitive, .copy-masked")).toHaveLength(0);
});

test("blank thinking does not add disclosure rows or split a process group", () => {
	const renderer = createRenderer(collectPageElements());
	renderer.render({ ...failureView("en", ""), attachedId: "s", blocks: [
		{ ...block, id: "thinking", kind: "thinking", text: " \n\t " }, block,
	] });
	expect(document.querySelector(".turn-process")).toBeNull();
	expect(document.querySelectorAll(".turn-user")).toHaveLength(1);
});
