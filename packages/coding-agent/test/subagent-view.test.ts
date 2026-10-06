import { Container, getKeybindings, setKeybindings, TuiMainScreen } from "@amazme/tui";
import type { SimpleStreamOptions } from "@amazme/ai";
import { fauxAssistantMessage } from "@amazme/ai";
import { beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ChildAgentBook, childLifecycleLine } from "../src/core/child-session.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { routeInteractiveInput } from "../src/modes/interactive/interactive-input.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { InteractiveComposer } from "../src/modes/interactive/composer-contract.ts";
import { scrollbackRows, TranscriptFocus } from "../src/modes/interactive/transcript-focus.ts";
import { finishAttachedBackgroundBash, ParentTranscript, syncComposerVisibility, WorkSurface } from "../src/modes/interactive/work-surface.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness } from "./suite/harness.ts";

function waitFor(ready: () => boolean): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const timer = setInterval(() => {
			if (ready()) {
				clearInterval(timer);
				resolve();
			} else if (Date.now() - start > 4000) {
				clearInterval(timer);
				reject(new Error("timed out waiting for child agent state"));
			}
		}, 10);
	});
}

function hold(signal: AbortSignal | undefined, release: Promise<void>): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			action();
		};
		const onAbort = () => finish(() => reject(new Error("aborted")));
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		void release.then(() => finish(resolve));
	});
}

describe("child agent presentation", () => {
	beforeAll(() => initTheme("dark"));

	test("a faux child session shows a lifecycle line, its own transcript, and a tasks row", async () => {
		const harness = await createHarness();
		let releaseChild = () => {};
		let releaseParent = () => {};
		const childGate = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		const parentGate = new Promise<void>((resolve) => {
			releaseParent = resolve;
		});
		harness.setResponses([
			async (_context, options: SimpleStreamOptions | undefined) => {
				await hold(options?.signal, childGate);
				return fauxAssistantMessage("child says hello");
			},
			async (_context, options: SimpleStreamOptions | undefined) => {
				await hold(options?.signal, parentGate);
				return fauxAssistantMessage("parent still going");
			},
		]);
		const previous = getKeybindings();
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const ui = new TuiMainScreen(new VirtualTerminal());
		const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
		editor.setText("parent draft");
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const chat = new Container();
		const parentEntry = new BashExecutionComponent("ls", ui);
		parentEntry.appendOutput("parent-file");
		chat.addChild(parentEntry);
		const surface = new WorkSurface(harness.session.childAgents, {
			list: () => [],
		} as never);
		chat.addChild(surface);
		const parentTranscript = new ParentTranscript();
		parentTranscript.bind(chat, surface);
		const composer = new InteractiveComposer(editor, {
			isTurnRunning: () => harness.session.isStreaming,
			send: () => {},
			queue: () => {},
			sendQueued: () => {},
			cancelAndSend: () => {},
			cancelTurn: () => {
				void harness.session.abort();
			},
			showEscHint: () => {},
		});
		const transcript = new TranscriptFocus(
			() => {},
			() =>
				scrollbackRows(
					chat.children.filter((child) => child !== surface),
					harness.session.childAgents.records,
					(id) => harness.session.childAgents.open(id),
				),
			10,
			(childId) => {
				harness.session.childAgents.highlightId = childId;
			},
		);
		editor.onBeforeInput = (data) => routeInteractiveInput(data, { child: surface, transcript, composer });
		const sync = () => {
			syncComposerVisibility(editorContainer, editor, surface.composerHidden);
			parentTranscript.project();
		};
		harness.session.childAgents.onChange(sync);
		let parentTurn: Promise<void> | undefined;
		try {
			const child = harness.session.spawnChild("do the thing", "work the task");
			await waitFor(() => childLifecycleLine(child).includes("Subagent running") && child.activity === "Thinking");
			expect(childLifecycleLine(child)).toContain('"do the thing"');
			expect(childLifecycleLine(child)).toContain(child.modelId);
			expect(surface.render(80).join("\n")).toContain("Subagent running");

			editor.handleInput("\t");
			editor.handleInput("\x1b[B");
			editor.handleInput("\r");
			expect(surface.composerHidden).toBe(true);
			expect(chat.children).toEqual([surface]);
			expect(chat.render(80).join("\n")).not.toContain("parent-file");
			expect(editorContainer.children).not.toContain(editor);
			expect(editor.render(40)).toEqual([]);
			const frame = surface.render(120).join("\n");
			expect(frame).toContain("running");
			expect(frame).toContain("do the thing");
			expect(frame).toContain(child.modelId);
			expect(frame).toContain("work the task");
			expect(frame).toMatch(/\ds/);

			const arrived = new BashExecutionComponent("while-open", ui);
			arrived.appendOutput("arrived-while-open");
			chat.addChild(arrived);
			expect(chat.children).toEqual([surface]);
			expect(chat.render(80).join("\n")).not.toContain("arrived-while-open");
			expect(chat.render(80).join("\n")).not.toContain("parent-file");
			expect(parentTranscript.contains(parentEntry)).toBe(true);
			expect(parentTranscript.contains(arrived)).toBe(true);
			parentTranscript.project();
			expect(chat.children).toEqual([surface]);
			expect(parentTranscript.list().filter((child) => child === parentEntry)).toHaveLength(1);
			expect(parentTranscript.contains(arrived)).toBe(true);

			const backgroundBash = new BashExecutionComponent("sleep 1", ui);
			backgroundBash.appendOutput("stream-line\n");
			backgroundBash.setBackgrounded();
			chat.addChild(backgroundBash);
			expect(chat.children).toEqual([surface]);
			expect(chat.render(80).join("\n")).not.toContain("Running in background");
			const finishedInPlace = finishAttachedBackgroundBash(backgroundBash, [parentTranscript], {
				command: backgroundBash.getCommand(),
				output: "stream-line\n",
				exitCode: 0,
			});
			expect(finishedInPlace).toBe(true);
			expect(backgroundBash.isBackgrounded()).toBe(false);
			expect(parentTranscript.list().filter((child) => child === backgroundBash)).toHaveLength(1);
			expect(chat.children).toEqual([surface]);

			parentTurn = harness.session.prompt("parent stays");
			await waitFor(() => harness.session.isStreaming);
			editor.handleInput("\x03");
			expect(child.status).toBe("cancelled");
			expect(harness.session.isStreaming).toBe(true);
			expect(editor.getText()).toBe("parent draft");

			editor.handleInput("q");
			expect(surface.composerHidden).toBe(false);
			expect(chat.children).toContain(parentEntry);
			expect(chat.children).toContain(arrived);
			expect(chat.render(80).join("\n")).toContain("parent-file");
			expect(chat.render(80).join("\n")).toContain("arrived-while-open");
			expect(chat.render(80).join("\n")).toContain("stream-line");
			expect(chat.render(80).join("\n")).not.toContain("Running in background");
			expect(parentTranscript.list().filter((child) => child === backgroundBash)).toHaveLength(1);
			expect(editorContainer.children).toContain(editor);
			expect(surface.render(120).join("\n")).toContain("Subagent cancelled");
			expect(surface.render(120).join("\n")).toContain('"do the thing"');

			editor.handleInput("\x07");
			editor.handleInput("\x1b[B");
			editor.handleInput("\x1b[B");
			editor.handleInput("\r");
			expect(surface.composerHidden).toBe(true);
			expect(chat.children).toEqual([surface]);
			expect(editorContainer.children).not.toContain(editor);
			expect(editor.render(40)).toEqual([]);
			parentTranscript.replaceAll([]);
			const compacted = new BashExecutionComponent("after-compact", ui);
			compacted.appendOutput("after-compact-only");
			chat.addChild(compacted);
			expect(chat.children).toEqual([surface]);
			expect(chat.render(80).join("\n")).not.toContain("parent-file");
			expect(chat.render(80).join("\n")).not.toContain("after-compact-only");
			editor.handleInput("q");
			const compactedText = chat.render(80).join("\n");
			expect(compactedText).toContain("after-compact-only");
			expect(compactedText).not.toContain("parent-file");
			expect(compactedText).not.toContain("arrived-while-open");
		} finally {
			releaseChild();
			releaseParent();
			await parentTurn?.catch(() => undefined);
			harness.cleanup();
			setKeybindings(previous);
		}
	});

	test("status lines coalesce on the transcript and an inserted row survives the next projection", () => {
		const ui = new TuiMainScreen(new VirtualTerminal());
		const chat = new Container();
		const surface = new WorkSurface(new ChildAgentBook(), { list: () => [] } as never);
		const parentTranscript = new ParentTranscript();
		parentTranscript.bind(chat, surface);
		const showStatus = Reflect.get(InteractiveMode.prototype, "showStatus") as (message: string) => void;
		const mode = {
			chatContainer: chat,
			parentTranscript,
			ui: { requestRender() {} },
			lastStatusSpacer: undefined as unknown,
			lastStatusText: undefined as unknown,
			lastStatusMessage: "",
		};
		showStatus.call(mode, "STATUS_ONE");
		showStatus.call(mode, "STATUS_TWO");
		expect(parentTranscript.list()).toHaveLength(2);
		const statusText = chat.render(80).join("\n");
		expect(statusText).toContain("STATUS_TWO");
		expect(statusText).not.toContain("STATUS_ONE");

		const streaming = new BashExecutionComponent("streaming-row", ui);
		const inserted = new BashExecutionComponent("custom-entry", ui);
		chat.addChild(streaming);
		expect(parentTranscript.insertBefore(inserted, streaming)).toBe(true);
		chat.addChild(new BashExecutionComponent("later-row", ui));
		const rendered = chat.render(80).join("\n");
		expect(rendered.indexOf("custom-entry")).toBeGreaterThanOrEqual(0);
		expect(rendered.indexOf("custom-entry")).toBeLessThan(rendered.indexOf("streaming-row"));
		expect(parentTranscript.contains(inserted)).toBe(true);
	});
});
