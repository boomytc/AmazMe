/**
 * @vitest-environment happy-dom
 */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { APPROVAL_APPROVE_ACTION, APPROVAL_DENY_ACTION } from "../src/actions.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { buildWebView, type WebViewInput } from "../src/view.ts";

const PENDING = [
	{ id: "approval-1", tool: "bash", detail: '{"command":"ls"}' },
	{ id: "approval-2", tool: "write", detail: '{"path":"notes.md"}' },
];

function input(pending: typeof PENDING, locale: WebViewInput["locale"] = "zh"): WebViewInput {
	return {
		locale,
		submitMode: "followUp",
		attachments: [],
		rosterFilter: "",
		approvals: { pending },
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
		dock: {
			open: false,
			tab: "files",
			cwd: "",
			workspace: undefined,
			terminal: undefined,
			conversations: undefined,
		},
		panel: { locale, current: "chat" },
		directory: undefined,
		transcript: undefined,
		attachedId: "s",
		now: 0,
		models: undefined,
		thinkingLevels: [],
	};
}

beforeAll(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	const body = html.slice(html.indexOf("<body>") + "<body>".length, html.lastIndexOf("</body>"));
	document.body.innerHTML = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});

describe("pending approval indicator", () => {
	test("stays in the header while approvals are pending, and leaves once they are decided", () => {
		const renderer = createRenderer(collectPageElements());
		renderer.render(buildWebView(input(PENDING)));

		const mark = document.getElementById("approval-status");
		const header = document.querySelector("header.header");
		expect(mark).not.toBeNull();
		expect(header?.contains(mark ?? null)).toBe(true);
		expect(document.getElementById("transcript")?.contains(mark ?? null)).toBe(false);
		expect(document.getElementById("composer-dock")?.contains(mark ?? null)).toBe(false);
		expect(mark?.hidden).toBe(false);
		expect(mark?.textContent).toBe("等待审批 2");
		// An empty transcript does not hide the mark.
		expect(document.getElementById("transcript-empty")).not.toBeNull();

		const cards = document.querySelectorAll(".approval-card");
		expect(document.getElementById("approvals")?.hidden).toBe(false);
		expect(cards).toHaveLength(2);
		expect(cards[0]?.querySelector(`[data-action="${APPROVAL_APPROVE_ACTION}"]`)?.getAttribute("data-action-data")).toBe("approval-1");
		expect(cards[0]?.querySelector(`[data-action="${APPROVAL_DENY_ACTION}"]`)).not.toBeNull();

		const transcript = document.getElementById("transcript");
		if (transcript !== null) transcript.scrollTop = 400;

		const approved = PENDING.filter((request) => request.id !== "approval-1");
		renderer.render(buildWebView(input(approved)));
		expect(document.getElementById("approval-status")?.hidden).toBe(false);
		expect(document.getElementById("approval-status")?.textContent).toBe("等待审批 1");
		expect(document.querySelectorAll(".approval-card")).toHaveLength(1);
		expect(header?.contains(document.getElementById("approval-status"))).toBe(true);

		renderer.render(buildWebView(input([])));
		expect(document.getElementById("approval-status")?.hidden).toBe(true);
		expect(document.getElementById("approval-status")?.textContent).toBe("");
		expect(document.getElementById("approvals")?.hidden).toBe(true);
		expect(document.querySelectorAll(".approval-card")).toHaveLength(0);
	});

	test("uses the english mark for an english page", () => {
		const renderer = createRenderer(collectPageElements());
		renderer.render(buildWebView(input(PENDING.slice(0, 1), "en")));
		const mark = document.getElementById("approval-status");
		expect(mark?.hidden).toBe(false);
		expect(mark?.textContent).toBe("Waiting for approval 1");
	});
});
