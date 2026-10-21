/**
 * @vitest-environment happy-dom
 */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { APPROVAL_APPROVE_ACTION, APPROVAL_DENY_ACTION, COMPACT_ACTION } from "../src/actions.ts";
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

	test("hides the context ring while empty and opens token and cost details on hover beside the model picker", () => {
		const elements = collectPageElements();
		const renderer = createRenderer(elements);
		const actions: { id: string }[] = [];
		renderer.onPanelAction = (action) => {
			if (action.kind === "command") actions.push({ id: action.id });
		};
		const emptyView = buildWebView(input([]));
		renderer.render(emptyView);
		expect(elements.meter.hidden).toBe(true);
		expect(elements.meter.closest(".header")).toBeNull();
		expect(elements.meter.parentElement?.classList.contains("composer-model-control")).toBe(true);
		expect(elements.meter.nextElementSibling?.classList.contains("composer-model-picker")).toBe(true);
		expect(document.querySelector("#meter-trigger .meter-ring")).not.toBeNull();
		expect(document.querySelector(".meter-chevron")).toBeNull();

		const tokensOnly = {
			...emptyView,
			meter: {
				context: "?",
				tokens: "792 / ?",
				cost: "$0.000",
				tone: "neutral" as const,
			},
		};
		renderer.render(tokensOnly);
		expect(elements.meter.hidden).toBe(false);
		expect(elements.meterContext.textContent).toBe("792");
		expect(elements.meterContext.parentElement?.hidden).toBe(false);
		expect(document.getElementById("meter-used")).toBeNull();
		expect(document.getElementById("meter-title")?.textContent).toBe("上下文窗口");
		expect(document.getElementById("meter-tokens-line")?.hidden).toBe(true);
		expect(elements.meter.dataset.meter).toBe("empty");
		expect(document.getElementById("meter-trigger")?.getAttribute("aria-label")).toBe("查看会话用量详情: 上下文 ?，token 792，费用 $0.000");

		const withUsage = {
			...emptyView,
			meter: {
				context: "42.5%",
				tokens: "8.5k / 20k",
				cost: "$0.125",
				tone: "neutral" as const,
			},
		};
		renderer.render(withUsage);
		expect(elements.meter.hidden).toBe(false);
		expect(elements.meterContext.parentElement?.hidden).toBe(true);
		const ringLength = 2 * Math.PI * 6;
		expect(Number(document.querySelector<SVGCircleElement>(".meter-ring-value")?.style.strokeDashoffset)).toBeCloseTo(ringLength * (1 - 0.425));
		expect(elements.meter.dataset.meter).toBeUndefined();
		expect(elements.meterTokens.textContent).toBe("8.5k / 20k");
		expect(document.getElementById("meter-tokens-line")?.hidden).toBe(false);
		expect(document.getElementById("meter-title")?.parentElement).toBe(document.getElementById("meter-context")?.parentElement?.parentElement);
		expect(document.getElementById("meter-tokens-line")?.parentElement).toBe(document.getElementById("meter-title")?.parentElement);
		expect(elements.meterCost.textContent).toBe("$0.125");
		expect(document.getElementById("meter-cost-label")?.textContent).toBe("计费");
		expect(document.getElementById("meter-cost-label")?.parentElement).toBe(document.getElementById("meter-cost")?.parentElement);
		const trigger = document.getElementById("meter-trigger");
		const detail = document.getElementById("meter-detail");
		expect(detail?.parentElement).toBe(document.body);
		expect(detail?.dataset.open).toBeUndefined();

		trigger?.dispatchEvent(new Event("pointerenter"));
		expect(detail?.dataset.open).toBe("true");
		trigger?.dispatchEvent(new Event("focus"));
		trigger?.dispatchEvent(new Event("pointerleave"));
		expect(detail?.dataset.open).toBe("true");
		trigger?.dispatchEvent(new Event("blur"));
		expect(detail?.dataset.open).toBeUndefined();
		expect(document.querySelector(`#run-actions [data-action="${COMPACT_ACTION}"]`)).toBeNull();

		const compact = document.getElementById("meter-compact");
		expect(compact).toBeInstanceOf(HTMLButtonElement);
		expect(compact?.textContent).toBe("压缩当前会话");
		expect(compact?.getAttribute("title")).toBe("将较早的对话压成摘要，释放上下文窗口。");
		expect((compact as HTMLButtonElement).disabled).toBe(false);
		detail?.dispatchEvent(new Event("pointerenter"));
		trigger?.dispatchEvent(new Event("pointerleave"));
		expect(detail?.dataset.open).toBe("true");
		compact?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(actions).toEqual([{ id: COMPACT_ACTION }]);
		expect(detail?.dataset.open).toBeUndefined();
		expect(detail?.getAttribute("aria-hidden")).toBe("true");
	});
});
