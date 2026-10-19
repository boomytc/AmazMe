/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { TRANSCRIPT_SEARCH_ACTION } from "../src/actions.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { failureView, type TranscriptBlock } from "../src/view.ts";

const CURRENT: TranscriptBlock = { id: "current", kind: "user", title: "You", text: "Current input", tone: "plain", running: false };
const OLDER: TranscriptBlock = { id: "older", kind: "user", title: "You", text: "Older secret", tone: "plain", running: false };

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});

function search(query: string): void {
	const input = document.querySelector<HTMLInputElement>("#transcript-search-input");
	if (input === null) throw new Error("missing transcript search");
	input.value = query;
	input.dispatchEvent(new Event("input"));
}

test("search hits mounted messages, including history already on the page", () => {
	const renderer = createRenderer(collectPageElements());
	renderer.render({
		...failureView("zh", ""),
		attachedId: "session",
		blocks: [CURRENT],
		history: { blocks: [OLDER], more: false, loading: false },
	});
	search("Older secret");
	expect(document.querySelector("#transcript-search-count")?.textContent).toBe("1/1");
	expect(document.querySelector("[data-block-id='older']")?.classList.contains("search-hit")).toBe(true);

	search("Current input");
	expect(document.querySelector("#transcript-search-count")?.textContent).toBe("1/1");
	expect(document.querySelector("[data-block-id='current']")?.classList.contains("search-hit")).toBe(true);
});

test("a query asks for unloaded history and highlights it once that history is mounted", () => {
	const elements = collectPageElements();
	const renderer = createRenderer(elements);
	elements.transcriptSearch.hidden = false;
	const actions: { id: string; data: string | undefined }[] = [];
	renderer.onPanelAction = (action) => {
		if (action.kind === "command") actions.push({ id: action.id, data: action.data });
	};
	renderer.render({
		...failureView("zh", ""),
		attachedId: "session",
		blocks: [CURRENT],
		history: { blocks: [], more: true, loading: false },
	});
	search("Older secret");
	expect(actions).toEqual([{ id: TRANSCRIPT_SEARCH_ACTION, data: "Older secret" }]);
	expect(document.querySelector("#transcript-search-count")?.textContent).toBe("没有匹配");

	renderer.render({
		...failureView("zh", ""),
		attachedId: "session",
		blocks: [CURRENT],
		history: { blocks: [OLDER], more: false, loading: false },
	});
	renderer.refreshTranscriptSearch();
	expect(document.querySelector("#transcript-search-count")?.textContent).toBe("1/1");
	expect(document.querySelector("[data-block-id='older']")?.classList.contains("search-hit")).toBe(true);
	expect(actions).toEqual([{ id: TRANSCRIPT_SEARCH_ACTION, data: "Older secret" }]);
});
