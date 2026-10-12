/**
 * @vitest-environment happy-dom
 */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ATTACHMENT_REMOVE_ACTION } from "../src/actions.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { buildWebView } from "../src/view.ts";
import type { WebViewInput } from "../src/view.ts";

const IMAGE = { id: "image-1", name: "chart.png", dataUrl: "data:image/png;base64,AAAA", bytes: 2048 };

function input(attachments: WebViewInput["attachments"], attachedId = "session-one"): WebViewInput {
	return {
		locale: "zh",
		submitMode: "followUp",
		attachments,
		rosterFilter: "",
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
		dock: { open: false, tab: "files", cwd: "", workspace: undefined, terminal: undefined, conversations: undefined },
		panel: { locale: "zh", current: "chat" },
		directory: undefined,
		transcript: undefined,
		attachedId,
		now: 0,
		models: undefined,
		thinkingLevels: [],
	};
}

const preview = (): HTMLButtonElement => {
	const node = document.querySelector<HTMLButtonElement>("button.attachment-preview");
	if (node === null) throw new Error("Missing the attachment preview control");
	return node;
};

const dialog = (): HTMLDialogElement | null => document.querySelector<HTMLDialogElement>("dialog.tool-image-dialog");

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	const body = html.slice(html.indexOf("<body>") + "<body>".length, html.lastIndexOf("</body>"));
	document.body.innerHTML = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});

describe("pending image preview", () => {
	test("opens the tool image dialog from the thumbnail and closes back onto it", () => {
		const renderer = createRenderer(collectPageElements());
		renderer.render(buildWebView(input([IMAGE])));

		expect(preview().getAttribute("aria-label")).toBe("预览这张图片");
		expect(preview().querySelector("img")?.getAttribute("src")).toBe(IMAGE.dataUrl);
		preview().focus();
		preview().click();

		const open = dialog();
		expect(open).not.toBeNull();
		expect(open?.querySelector("img")?.getAttribute("src")).toBe(IMAGE.dataUrl);
		expect(open?.querySelector("img")?.getAttribute("alt")).toBe("chart.png");
		expect(open?.getAttribute("aria-label")).toBe("查看图片");

		open?.close();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(preview());
	});

	test("keeps the remove control apart from the preview", () => {
		const renderer = createRenderer(collectPageElements());
		const report = vi.fn();
		renderer.onPanelAction = report;
		renderer.render(buildWebView(input([IMAGE])));

		const remove = document.querySelector<HTMLButtonElement>(".attachment-remove");
		expect(remove).not.toBeNull();
		remove?.click();
		expect(report).toHaveBeenLastCalledWith({ kind: "command", id: ATTACHMENT_REMOVE_ACTION, data: "image-1" });
		expect(dialog()).toBeNull();
	});

	test("returns focus to the current thumbnail after another image finishes attaching", () => {
		const renderer = createRenderer(collectPageElements());
		renderer.render(buildWebView(input([IMAGE])));
		preview().focus();
		preview().click();
		const open = dialog();
		const otherImage = { ...IMAGE, id: "image-2", name: "other.png" };

		renderer.render(buildWebView(input([IMAGE, otherImage])));
		expect(dialog()).toBe(open);
		open?.close();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(preview());
	});

	test("closes when the conversation changes inside the same session", () => {
		const renderer = createRenderer(collectPageElements());
		const view = buildWebView(input([IMAGE]));
		renderer.render(view);
		preview().click();

		renderer.render({ ...view, transcriptScope: "session-one:child" });
		expect(dialog()).toBeNull();
	});

	test("closes when management replaces the composer", () => {
		const renderer = createRenderer(collectPageElements());
		const view = buildWebView(input([IMAGE]));
		renderer.render(view);
		preview().click();

		renderer.render({ ...view, panel: { ...view.panel, current: "settings", panel: { id: "settings", title: "Settings", notices: [], groups: [] } } });
		expect(dialog()).toBeNull();
	});

	test("closes once its picture leaves the strip, and never follows into another session", () => {
		const renderer = createRenderer(collectPageElements());
		renderer.render(buildWebView(input([IMAGE])));
		preview().click();
		expect(dialog()).not.toBeNull();

		// The host accepted the prompt: the strip is empty, so the preview has nothing left to show.
		renderer.render(buildWebView(input([])));
		expect(dialog()).toBeNull();

		renderer.render(buildWebView(input([IMAGE])));
		preview().click();
		expect(dialog()).not.toBeNull();

		// The same picture is attached in the next session: the open dialog still belongs to the old one.
		renderer.render(buildWebView(input([IMAGE], "session-two")));
		expect(dialog()).toBeNull();
	});
});
