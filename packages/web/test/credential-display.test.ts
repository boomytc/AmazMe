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
afterEach(() => vi.restoreAllMocks());

test("sent and queued credentials start masked; each native button reveals only its own range", () => {
	const renderer = createRenderer(collectPageElements());
	const view: WebView = { ...failureView("en", ""), attachedId: "s", blocks: [block], queue: [
		{ id: "q", text: key, cancel: { id: "withdraw", label: "Withdraw", tone: "default" } },
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

test("blank thinking does not add disclosure rows or split a process group", () => {
	const renderer = createRenderer(collectPageElements());
	renderer.render({ ...failureView("en", ""), attachedId: "s", blocks: [
		{ ...block, id: "thinking", kind: "thinking", text: " \n\t " }, block,
	] });
	expect(document.querySelector(".turn-process")).toBeNull();
	expect(document.querySelectorAll(".turn-user")).toHaveLength(1);
});
