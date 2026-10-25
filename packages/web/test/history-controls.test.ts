/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { HISTORY_MORE_ACTION } from "../src/actions.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { translate } from "../src/strings.ts";
import { failureView } from "../src/view.ts";
import type { TranscriptBlock } from "../src/view.ts";

const BLOCK: TranscriptBlock = { id: "1", kind: "user", title: "You", text: "Current input", tone: "plain", running: false };

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});

test("an existing transcript does not offer older history until it is confirmed", () => {
	const renderer = createRenderer(collectPageElements());
	const view = { ...failureView("zh", ""), attachedId: "session", blocks: [BLOCK] };
	renderer.render(view);
	expect(document.querySelector(".history-more-button")).toBeNull();
	expect(document.querySelector(".column")?.textContent).toContain("Current input");

	const actions: string[] = [];
	renderer.onPanelAction = (action) => { if (action.kind === "command") actions.push(action.id); };
	renderer.render({ ...view, history: { blocks: [], more: true, loading: false } });
	const button = document.querySelector<HTMLButtonElement>(".history-more-button");
	expect(button?.textContent).toBe(translate("zh", "history.more"));
	button?.click();
	expect(actions).toEqual([HISTORY_MORE_ACTION]);

	renderer.render({ ...view, history: { blocks: [], more: true, loading: true } });
	const loading = document.querySelector<HTMLButtonElement>(".history-more-button");
	expect(loading?.textContent).toBe(translate("zh", "history.loading"));
	expect(loading?.disabled).toBe(true);

	renderer.render({ ...view, history: { blocks: [{ ...BLOCK, id: "older", text: "Older input" }], more: false, loading: false } });
	expect(document.querySelector(".history-more-button")).toBeNull();
	expect(document.querySelector(".history-pages")?.textContent).toContain("Older input");
});

test("an empty conversation never offers history loading", () => {
	const renderer = createRenderer(collectPageElements());
	renderer.render({ ...failureView("zh", ""), attachedId: "session", history: { blocks: [], more: true, loading: false } });
	expect(document.querySelector(".history-more-button")).toBeNull();
});

test("scrolling away from the bottom offers a jump-to-latest control and announces new progress below", () => {
	const elements = collectPageElements();
	const renderer = createRenderer(elements);
	Object.defineProperty(elements.transcript, "scrollHeight", { configurable: true, get: () => 1200 });
	Object.defineProperty(elements.transcript, "clientHeight", { configurable: true, get: () => 400 });
	elements.transcript.scrollTop = 800;

	const base = { ...failureView("zh", ""), attachedId: "session", blocks: [BLOCK] };
	renderer.render(base);
	expect(elements.transcriptLatest?.hidden).toBe(true);

	elements.transcript.scrollTop = 200;
	elements.transcript.dispatchEvent(new Event("scroll"));
	expect(elements.transcriptLatest?.hidden).toBe(false);
	expect(elements.transcriptLatest?.textContent).toBe("回到最新");
	expect(elements.transcriptLatest?.dataset.unread).toBeUndefined();

	renderer.render({
		...base,
		blocks: [
			BLOCK,
			{ id: "2", kind: "assistant", title: "AmazMe", text: "正在输出长回答第一段", tone: "plain", running: true },
		],
		status: "处理中…",
	});
	expect(elements.transcript.scrollTop).toBe(200);
	expect(elements.transcriptLatest?.hidden).toBe(false);
	expect(elements.transcriptLatest?.dataset.unread).toBe("true");
	expect(elements.transcriptLatest?.textContent).toBe("有新内容 · 回到最新");

	elements.transcriptLatest?.click();
	expect(elements.transcript.scrollTop).toBe(1200);
	expect(elements.transcriptLatest?.hidden).toBe(true);
	expect(elements.transcriptLatest?.dataset.unread).toBeUndefined();
});
