/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { AssistantEntry, UserEntry, type ConversationId, type ConversationView, type EntryId } from "@amazme/durable";
import type { AssistantMessage } from "@amazme/ai";
import { promptSuggestionContext, PromptSuggestionController } from "../src/prompt-suggestions.ts";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { failureView, type WebView } from "../src/view.ts";

const candidate = { key: "session:branch:answer", text: "请解释两种方案各自适合的使用场景。" };
const view = (): WebView => ({ ...failureView("zh", ""), attachedId: "session", suggestion: candidate });
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});

function setup() {
	const elements = collectPageElements(), renderer = createRenderer(elements);
	const submit = vi.fn(), draft = vi.fn(), dismiss = vi.fn();
	renderer.onSubmit = submit; renderer.onDraftChange = draft; renderer.onDismissSuggestion = dismiss;
	renderer.render(view()); elements.prompt.focus();
	const key = (key: string, init: KeyboardEventInit = {}) => {
		const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
		elements.prompt.dispatchEvent(event); return event;
	};
	return { renderer, elements, submit, draft, dismiss, key };
}

test("Tab accepts one editable draft without submitting; Enter remains explicit", () => {
	const { elements, submit, draft, dismiss, key } = setup();
	expect(elements.prompt.placeholder).toBe("");
	expect(elements.prompt.getAttribute("aria-label")).toBe("消息");
	expect(elements.prompt.getAttribute("aria-describedby")).toBe("suggestion-hint");
	expect(key("Tab").defaultPrevented).toBe(true);
	expect(elements.prompt.value).toBe(candidate.text);
	expect(elements.prompt.selectionStart).toBe(candidate.text.length);
	expect(draft).toHaveBeenCalledWith(candidate.text);
	expect(dismiss).toHaveBeenCalledOnce();
	expect(submit).not.toHaveBeenCalled();
	expect(document.querySelector<HTMLElement>("#composer-suggestion")?.hidden).toBe(true);
	key("Enter"); expect(submit).toHaveBeenCalledWith(candidate.text);
});

test("mouse accept and dismiss have the same non-submitting semantics", () => {
	const { elements, submit, renderer } = setup();
	document.querySelector<HTMLButtonElement>("#suggestion-accept")!.click();
	expect(elements.prompt.value).toBe(candidate.text); expect(submit).not.toHaveBeenCalled();
	renderer.setDraft(""); renderer.render({ ...view(), suggestion: { key: "next", text: candidate.text } });
	document.querySelector<HTMLButtonElement>("#suggestion-dismiss")!.click();
	expect(elements.prompt.value).toBe(""); expect(document.activeElement).toBe(elements.prompt);
	expect(document.querySelector<HTMLElement>("#composer-suggestion")?.hidden).toBe(true);
});

test("full suggestion preview is literal, never accepts or submits, and tracks candidate identity", () => {
	const { renderer, elements, submit, draft, dismiss } = setup();
	const text = "<img src=x onerror=alert(1)> " + candidate.text.repeat(20);
	const source = { ...view(), suggestion: { key: "long", text } };
	renderer.render(source);
	const preview = document.querySelector<HTMLElement>("#suggestion-preview")!;
	const control = document.querySelector<HTMLButtonElement>("#suggestion-preview-toggle")!;
	expect(preview.hidden).toBe(true);
	control.click();
	expect(preview.hidden).toBe(false);
	expect(preview.textContent).toBe(text);
	expect(preview.querySelector("img")).toBeNull();
	expect(document.activeElement).toBe(preview);
	expect(control.getAttribute("aria-expanded")).toBe("true");
	expect(elements.prompt.value).toBe("");
	expect(submit).not.toHaveBeenCalled(); expect(draft).not.toHaveBeenCalled(); expect(dismiss).not.toHaveBeenCalled();
	const textNode = preview.firstChild!;
	const range = document.createRange(); range.setStart(textNode, 0); range.setEnd(textNode, 12);
	const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
	renderer.render({ ...source, sessionLabel: "renamed" });
	expect(preview.hidden).toBe(false); expect(preview.firstChild).toBe(textNode);
	expect(selection.toString()).toBe(text.slice(0, 12));
	renderer.render({ ...source, busy: true }); expect(preview.hidden).toBe(true);
	renderer.render(source); expect(preview.hidden).toBe(false);
	renderer.render({ ...source, suggestion: { key: "new", text: "New candidate" } });
	expect(preview.hidden).toBe(true); expect(preview.textContent).toBe("New candidate");
	control.click();
	preview.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	expect(preview.hidden).toBe(true); expect(elements.prompt.value).toBe("");
	expect(document.activeElement).toBe(elements.prompt); expect(dismiss).toHaveBeenCalledOnce();
});

test("touch accept text is localized and the preview hides when the draft is filled", () => {
	const { renderer, elements, submit } = setup();
	expect(document.querySelector(".suggestion-touch-label")?.textContent).toBe("填入");
	renderer.render({ ...view(), locale: "en" });
	expect(document.querySelector(".suggestion-touch-label")?.textContent).toBe("Use draft");
	document.querySelector<HTMLButtonElement>("#suggestion-preview-toggle")!.click();
	document.querySelector<HTMLButtonElement>("#suggestion-accept")!.click();
	expect(document.querySelector<HTMLElement>("#suggestion-preview")?.hidden).toBe(true);
	expect(elements.prompt.value).toBe(candidate.text); expect(submit).not.toHaveBeenCalled();
});

test("Escape dismisses only this candidate; ordinary and modified Tab retain navigation", () => {
	const { key, elements, renderer } = setup();
	expect(key("Tab", { shiftKey: true }).defaultPrevented).toBe(false);
	expect(key("Tab", { ctrlKey: true }).defaultPrevented).toBe(false);
	expect(elements.prompt.value).toBe("");
	expect(key("Escape").defaultPrevented).toBe(true);
	renderer.render(view());
	expect(key("Tab").defaultPrevented).toBe(false);
	expect(elements.prompt.placeholder).toBe("继续提问或描述下一步…");
});

test("Escape dismisses the suggestion from anywhere in the conversation", () => {
	const { elements, dismiss } = setup();
	document.body.focus();
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	expect(dismiss).toHaveBeenCalledOnce();
	expect(document.querySelector<HTMLElement>("#composer-suggestion")?.hidden).toBe(true);
	expect(elements.prompt.placeholder).toBe("继续提问或描述下一步…");
	expect(elements.prompt.value).toBe("");
});

test("typing suppresses the overlay and never replaces the reader's draft", () => {
	const { elements, key, renderer } = setup();
	elements.prompt.value = "我的问题"; elements.prompt.dispatchEvent(new Event("input"));
	renderer.render(view());
	expect(document.querySelector<HTMLElement>("#composer-suggestion")?.hidden).toBe(true);
	expect(key("Tab").defaultPrevented).toBe(false);
	expect(elements.prompt.value).toBe("我的问题");
});

test("IME composition guards Tab, Enter and Escape, including legacy 229 events", () => {
	const { elements, key, submit } = setup();
	for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
		for (const name of ["Tab", "Enter", "Escape"]) expect(key(name, init).defaultPrevented).toBe(false);
	}
	elements.prompt.dispatchEvent(new Event("compositionstart"));
	expect(key("Tab").defaultPrevented).toBe(false);
	expect(key("Enter").defaultPrevented).toBe(false);
	elements.prompt.dispatchEvent(new Event("compositionend"));
	expect(elements.prompt.value).toBe(""); expect(submit).not.toHaveBeenCalled();
});

test("command palette owns Tab; unavailable, busy, approval, attachment and queued states hide candidates", () => {
	const { renderer, key, elements } = setup();
	const pick = vi.fn(); renderer.onCommandPick = pick;
	renderer.render({ ...view(), palette: { ...view().palette, open: true, rows: [{ value: "help", label: "Help", description: "", selected: true }] } });
	key("Tab"); expect(pick).toHaveBeenCalledWith("help"); expect(elements.prompt.value).toBe("");
	for (const changed of [{ busy: true }, { readOnly: true }, { attachedId: undefined },
		{ attachments: [{ id: "image", name: "image", dataUrl: "data:image/png;base64,eA==", size: "1 B", remove: { id: "remove", label: "Remove", tone: "default" as const } }] },
		{ queue: [{ id: "queue", text: "Queued", cancel: { id: "cancel", label: "Cancel", tone: "default" as const } }] }]) {
		renderer.render({ ...view(), ...changed });
		expect(document.querySelector<HTMLElement>("#composer-suggestion")?.hidden).toBe(true);
		expect(key("Tab").defaultPrevented).toBe(false);
	}
});

test("generates once, discards late results on typing and isolates session/branch/answer keys", async () => {
	const changed = vi.fn(), control = new PromptSuggestionController(changed);
	const first = Promise.withResolvers<string | null>();
	const request = vi.fn((_signal: AbortSignal) => first.promise);
	control.update("a", true, request); await tick();
	control.update("a", true, request); expect(request).toHaveBeenCalledOnce();
	control.update("a", false, request);
	expect(request.mock.calls[0]![0].aborted).toBe(true);
	first.resolve("Old result"); await tick(); expect(control.valueFor("a")).toBeUndefined();
	control.update("a", true, request); await tick(); expect(request).toHaveBeenCalledOnce();
	control.update("b", true, async () => "New result"); await tick();
	expect(control.valueFor("b")).toEqual({ key: "b", text: "New result" });
	control.dismiss(); control.update("b", true, request); await tick();
	expect(control.valueFor("b")).toBeUndefined(); expect(request).toHaveBeenCalledOnce();
});

test("keeps a settled candidate across a temporary panel or modal and clears it when the source changes", async () => {
	const control = new PromptSuggestionController(() => {}), request = vi.fn(async () => "当前候选");
	control.update("a", true, request); await tick();
	control.update("a", false, request);
	expect(control.valueFor("a")).toEqual({ key: "a", text: "当前候选" });
	// A rebind blips the source to undefined and back; the answer keeps its candidate.
	control.update(undefined, false, request); await tick();
	control.update("a", true, request);
	expect(control.valueFor("a")?.text).toBe("当前候选"); expect(request).toHaveBeenCalledOnce();
	expect(control.valueFor("b")).toBeUndefined();
	control.update("b", false, request);
	expect(control.valueFor("a")).toBeUndefined();
});

test("switching scope cancels a pending request; disabled and failed generation do not loop", async () => {
	const control = new PromptSuggestionController(() => {}), first = Promise.withResolvers<string | null>();
	const request = vi.fn(async () => { throw new Error("offline"); });
	control.update("a", true, () => first.promise); await tick();
	control.update("b", true, async () => "Current"); first.resolve("Stale"); await tick();
	expect(control.valueFor("b")?.text).toBe("Current");
	control.update("c", false, request); await tick(); expect(request).not.toHaveBeenCalled();
	control.update("c", true, request); await tick();
	control.update("c", true, request); await tick(); expect(request).toHaveBeenCalledOnce();
	control.update(undefined, false, request); expect(control.valueFor("c")).toBeUndefined();
});

function conversation(answer: string, stopReason: AssistantMessage["stopReason"] = "stop"): ConversationView {
	const message: AssistantMessage = { role: "assistant", content: [{ type: "thinking", thinking: "private process" }, { type: "text", text: answer }],
		api: "openai-completions", provider: "test", model: "test", timestamp: 1, stopReason,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	return { conversation: { id: 1 as ConversationId } as ConversationView["conversation"], docs: {}, entries: [
		{ id: 1 as EntryId, conversationId: 1 as ConversationId, kind: UserEntry.kind, model: [{ role: "user", content: "compare versions", timestamp: 0 }] },
		{ id: 2 as EntryId, conversationId: 1 as ConversationId, kind: AssistantEntry.kind, model: [message] },
	] };
}

test("context contains only the latest user and successful final answer, never reasoning or tool output", () => {
	expect(promptSuggestionContext(conversation("Result"))).toEqual({ conversationId: "1", answerEntryId: "2", user: "compare versions", answer: "Result" });
	for (const stop of ["error", "aborted", "length", "toolUse"] as const) expect(promptSuggestionContext(conversation("partial", stop))).toBeUndefined();
	expect(promptSuggestionContext(conversation("Which option?"))).toBeUndefined();
	const source = conversation("x".repeat(8000));
	expect(promptSuggestionContext(source)?.answer).toHaveLength(6000);
	expect(promptSuggestionContext({ ...source, entries: [...source.entries, source.entries[0]!] })).toBeUndefined();
	expect(promptSuggestionContext({ ...source, entries: source.entries.slice(1) })).toBeUndefined();
});
