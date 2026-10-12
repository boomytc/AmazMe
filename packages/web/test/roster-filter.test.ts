/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { buildWebView, type WebViewInput } from "../src/view.ts";

function input(rosterFilter: string): WebViewInput {
	return {
		locale: "zh",
		submitMode: "followUp",
		attachments: [],
		rosterFilter,
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
		panel: { locale: "zh", current: "chat" },
		directory: undefined,
		transcript: undefined,
		attachedId: undefined,
		now: 0,
		models: undefined,
		thinkingLevels: [],
		dock: {
			open: false,
			tab: "files",
			cwd: "",
			workspace: undefined,
			terminal: undefined,
			conversations: undefined,
		},
	};
}

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});

test("the session filter stays an icon in the brand row until it is opened", () => {
	const elements = collectPageElements();
	const renderer = createRenderer(elements);
	const queries: string[] = [];
	renderer.onFilterRoster = (text) => {
		queries.push(text);
	};
	renderer.render(buildWebView(input("")));
	expect(elements.rosterFilterField.closest(".brand")).toBe(elements.sessionSidebar.querySelector(".brand"));
	expect(elements.rosterFilter.hidden).toBe(true);
	expect(elements.rosterFilterToggle.getAttribute("aria-expanded")).toBe("false");

	elements.rosterFilterToggle.click();
	expect(elements.rosterFilter.hidden).toBe(false);
	expect(elements.rosterFilterToggle.getAttribute("aria-expanded")).toBe("true");
	expect(document.activeElement).toBe(elements.rosterFilter);

	elements.rosterFilter.value = "周";
	elements.rosterFilter.dispatchEvent(new Event("input"));
	expect(queries).toEqual(["周"]);

	elements.rosterFilter.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	expect(queries).toEqual(["周", ""]);
	expect(elements.rosterFilter.hidden).toBe(true);
	expect(document.activeElement).toBe(elements.rosterFilterToggle);

	renderer.render(buildWebView(input("周报")));
	expect(elements.rosterFilter.hidden).toBe(false);
	expect(elements.rosterFilter.value).toBe("周报");
});
