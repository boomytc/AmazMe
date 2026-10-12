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
